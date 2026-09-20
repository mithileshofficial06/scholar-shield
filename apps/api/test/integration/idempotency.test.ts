/**
 * PIPELINE IDEMPOTENCY (PROJECT_REPORT.md §10, "Pipeline semantics").
 *
 *     npm run test:integration
 *
 * The report makes a specific promise: *"Every stage handler is idempotent,
 * keyed on (document_id, stage). BullMQ is at-least-once; a redelivered job must
 * not double-write flags."* Until this file that was an unverified claim — the
 * mechanism was written carefully and nothing demonstrated it worked.
 *
 * These run against a real Postgres because the mechanism IS the database: a
 * UNIQUE constraint picking a winner between two concurrent claims, and an
 * ON CONFLICT clause turning a replayed write into a no-op. Against a mocked
 * client they would assert that the mock does what the mock was told to do.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { query } from '../../src/db.js';
import { processDocument } from '../../src/pipeline/worker.js';
import { MAX_ATTEMPTS, runStage } from '../../src/pipeline/stageRunner.js';
import {
  closePool,
  requireDatabase,
  resetData,
  seedApplication,
  stubContext,
} from './helpers.js';

beforeAll(requireDatabase);
beforeEach(resetData);
afterAll(closePool);

const flagCount = async (applicationId: string) => {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM risk_flags WHERE application_id = $1`,
    [applicationId],
  );
  return Number(rows[0]!.n);
};

const stageRuns = async (documentId: string) => {
  const { rows } = await query<{ stage: string; status: string; attempts: number }>(
    `SELECT stage, status, attempts FROM pipeline_stage_runs
      WHERE document_id = $1 ORDER BY stage`,
    [documentId],
  );
  return rows;
};

describe('a redelivered job', () => {
  it('does not run any stage a second time', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx, counts } = stubContext();

    const first = await processDocument({ documentId, applicationId }, ctx);
    expect(first.completed).toHaveLength(5);
    expect(counts.extract).toBe(1);
    expect(counts.forensics).toBe(1);

    // Exactly what at-least-once delivery looks like: the same job, again.
    const second = await processDocument({ documentId, applicationId }, ctx);

    // The expensive work is the proof. "The stage did not re-run" is only
    // convincing if OCR was not called again behind it.
    expect(counts.extract).toBe(1);
    expect(counts.forensics).toBe(1);
    expect(counts.load).toBe(2); // once for OCR, once for forensics, first run only

    // The replay still walks the chain and still reports five completed stages,
    // because from the caller's side the document IS fully processed. That is
    // the right answer to give a queue: a redelivered job should look like a
    // success, not like an error, or BullMQ retries it forever. Idempotency is
    // about the work not happening twice, not about the second answer differing.
    expect(second.completed).toHaveLength(5);
    expect(second.stoppedAt).toBeNull();
    expect(second.deadLettered).toBe(false);
  });

  it('does not write a second set of risk flags', async () => {
    // Two applications in one household with contradictory incomes, so the
    // scoring stage has something to write and the count is not trivially 0.
    const one = await seedApplication({
      guardianName: 'Muthusamy Govindaraj',
      addressLine: '27 Kongu Nagar, Peelamedu',
      guardianPhone: '9345112200',
      declaredAnnualIncome: 96_000,
    });
    const two = await seedApplication({
      guardianName: 'Muthusamy Govindaraj',
      addressLine: '27 Kongu Nagar, Peelamedu',
      guardianPhone: '9345112200',
      declaredAnnualIncome: 178_000,
    });

    const { ctx } = stubContext();
    await processDocument({ documentId: one.documentId, applicationId: one.applicationId }, ctx);
    await processDocument({ documentId: two.documentId, applicationId: two.applicationId }, ctx);

    const before = await flagCount(two.applicationId);
    expect(before).toBeGreaterThan(0);

    await processDocument({ documentId: two.documentId, applicationId: two.applicationId }, ctx);
    expect(await flagCount(two.applicationId)).toBe(before);
  });

  it('leaves one stage-run row per stage, not one per delivery', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext();

    await processDocument({ documentId, applicationId }, ctx);
    await processDocument({ documentId, applicationId }, ctx);
    await processDocument({ documentId, applicationId }, ctx);

    const runs = await stageRuns(documentId);
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    // Still one attempt each: a succeeded stage is never re-claimed, so the
    // counter cannot creep upward on redelivery.
    expect(runs.every((r) => r.attempts === 1)).toBe(true);
  });
});

describe('two workers handed the same job at once', () => {
  it('lets exactly one of them run the stage', async () => {
    const { documentId } = await seedApplication();
    let running = 0;
    let concurrent = 0;

    const work = async () => {
      running += 1;
      concurrent = Math.max(concurrent, running);
      // Hold the claim long enough that a second claimer would overlap if the
      // constraint were not doing its job.
      await new Promise((resolve) => setTimeout(resolve, 120));
      running -= 1;
      return { ok: true };
    };

    const [a, b] = await Promise.all([
      runStage(documentId, 'ocr_extract', work),
      runStage(documentId, 'ocr_extract', work),
    ]);

    expect(concurrent).toBe(1);
    expect([a!.ran, b!.ran].filter(Boolean)).toHaveLength(1);

    const loser = a!.ran ? b! : a!;
    // The loser reports what it found rather than throwing: from its side, a
    // stage another worker owns is indistinguishable from one already done.
    expect(loser.ran).toBe(false);
  });

  it('serialises a burst of eight deliveries down to one execution', async () => {
    const { documentId } = await seedApplication();
    let executions = 0;

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        runStage(documentId, 'forensics_analyze', async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true };
        }),
      ),
    );

    expect(executions).toBe(1);
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
  });
});

describe('a stage that fails', () => {
  it('is retried, and dead-lettered once attempts run out', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext({ failExtract: true });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await processDocument({ documentId, applicationId }, ctx).catch(() => undefined);
    }

    const runs = await stageRuns(documentId);
    const ocr = runs.find((r) => r.stage === 'ocr_extract')!;
    expect(ocr.status).toBe('dead_lettered');
    expect(ocr.attempts).toBe(MAX_ATTEMPTS);
  });

  it('stops the chain rather than scoring on half a document', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx, counts } = stubContext({ failExtract: true });

    await processDocument({ documentId, applicationId }, ctx).catch(() => undefined);

    // Forensics must not have run: a document whose text could not be read has
    // nothing for the later stages to reconcile.
    expect(counts.forensics).toBe(0);
    expect(await flagCount(applicationId)).toBe(0);
  });

  it('resumes from the failed stage instead of restarting from OCR', async () => {
    const { applicationId, documentId } = await seedApplication();

    const failing = stubContext({ failExtract: true });
    await processDocument({ documentId, applicationId }, failing.ctx).catch(() => undefined);
    expect(failing.counts.extract).toBe(1);

    // A fresh context, as a retry after the transient fault cleared.
    const recovered = stubContext();
    const outcome = await processDocument({ documentId, applicationId }, recovered.ctx);

    expect(outcome.completed).toHaveLength(5);
    // OCR ran once more because it was the stage that failed -- and exactly
    // once, not once per stage in the chain behind it.
    expect(recovered.counts.extract).toBe(1);
  });
});

describe('the verification link', () => {
  it('is not appended a second time when the chain is replayed', async () => {
    // A re-run used to add a fresh manual_check_required row, which as the
    // newest row silently replaced a result a reviewer had already recorded.
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext();

    await processDocument({ documentId, applicationId }, ctx);

    await query(
      `UPDATE pipeline_stage_runs SET status = 'pending', attempts = 0
        WHERE document_id = $1 AND stage = 'verification_check'`,
      [documentId],
    );
    await processDocument({ documentId, applicationId }, ctx);

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM verification_results WHERE application_id = $1`,
      [applicationId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
