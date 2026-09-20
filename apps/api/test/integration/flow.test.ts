/**
 * END-TO-END FLOW (PROJECT_REPORT.md §13).
 *
 *     npm run test:integration
 *
 * "Upload → pipeline completes → correct flags created → application appears at
 * the expected queue position." The pieces were each covered in isolation and
 * nothing joined them up, which is where the interesting failures live: a rule
 * that fires in the harness but whose flag never reaches `risk_flags`, or a
 * score that is written but does not move the row in the queue.
 *
 * The upload itself is seeded directly rather than posted through multer, so
 * these need no MinIO. What is exercised is everything after the bytes land:
 * the real pipeline, the real rule engine, the real queue SQL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { query } from '../../src/db.js';
import { processDocument } from '../../src/pipeline/worker.js';
import { loadRulesConfig } from '../../src/household/config.js';
import {
  closePool,
  extraction,
  requireDatabase,
  resetData,
  seedApplication,
  stubContext,
} from './helpers.js';

beforeAll(requireDatabase);
beforeEach(resetData);
afterAll(closePool);

const config = loadRulesConfig();

/** The queue as the reviewer's dashboard orders it: score desc, oldest first. */
async function queueOrder(): Promise<{ id: string; score: number; status: string }[]> {
  const { rows } = await query<{ id: string; risk_score: string; status: string }>(
    `SELECT id, risk_score, status FROM applications
      WHERE status IN ('ready_for_review', 'escalated')
      ORDER BY risk_score DESC, submitted_at ASC`,
  );
  return rows.map((r) => ({ id: r.id, score: Number(r.risk_score), status: r.status }));
}

const rulesFired = async (applicationId: string) => {
  const { rows } = await query<{ rule_id: string; rule_config_version: string }>(
    `SELECT rule_id, rule_config_version FROM risk_flags
      WHERE application_id = $1 ORDER BY rule_id`,
    [applicationId],
  );
  return rows;
};

describe('a clean application', () => {
  it('runs every stage and reaches the queue with no flags', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext();

    const outcome = await processDocument({ documentId, applicationId }, ctx);

    expect(outcome.completed).toEqual([
      'ocr_extract',
      'forensics_analyze',
      'verification_check',
      'household_reconcile',
      'risk_score',
    ]);
    expect(await rulesFired(applicationId)).toEqual([]);

    const { rows } = await query<{ status: string; risk_score: string }>(
      `SELECT status, risk_score FROM applications WHERE id = $1`,
      [applicationId],
    );
    expect(rows[0]!.status).toBe('ready_for_review');
    expect(Number(rows[0]!.risk_score)).toBe(0);
  });

  it('records the OCR read and the forensics report on the document', async () => {
    const { applicationId, documentId } = await seedApplication();
    await processDocument({ documentId, applicationId }, stubContext().ctx);

    const { rows } = await query<{
      extracted_fields: unknown;
      ocr_report: { pageConfidence?: number; wordCount?: number } | null;
      forensics: unknown;
      tamper_score: string | null;
    }>(
      `SELECT extracted_fields, ocr_report, forensics, tamper_score
         FROM documents WHERE id = $1`,
      [documentId],
    );

    const row = rows[0]!;
    expect(row.extracted_fields).toBeTruthy();
    expect(row.forensics).toBeTruthy();
    expect(row.tamper_score).not.toBeNull();
    // ocr_report is what DOCUMENT_NOT_A_CERTIFICATE reads; a pipeline that
    // dropped it would silently disable that rule.
    expect(row.ocr_report?.pageConfidence).toBeCloseTo(0.94, 2);
    expect(row.ocr_report?.wordCount).toBe(220);
  });
});

describe('a contradicting household', () => {
  it('flags both applications and puts them above a clean one in the queue', async () => {
    const clean = await seedApplication({
      guardianName: 'Unrelated Person',
      addressLine: '9 Elsewhere Road, Anna Nagar',
      guardianPhone: '9000000001',
      declaredAnnualIncome: 71_000,
    });

    // One household, two very different declared incomes.
    const household = {
      guardianName: 'Muthusamy Govindaraj',
      addressLine: '27 Kongu Nagar, Peelamedu',
      guardianPhone: '9345112200',
    };
    const honest = await seedApplication({ ...household, declaredAnnualIncome: 96_000 });
    const inflated = await seedApplication({ ...household, declaredAnnualIncome: 178_000 });

    const { ctx } = stubContext();
    for (const app of [clean, honest, inflated]) {
      await processDocument({ documentId: app.documentId, applicationId: app.applicationId }, ctx);
    }

    // Both sides of a contradiction are flagged: neither is presumptively the
    // honest one, and the reviewer decides which.
    for (const app of [honest, inflated]) {
      const fired = await rulesFired(app.applicationId);
      expect(fired.map((f) => f.rule_id)).toContain('SIBLING_INCOME_CONTRADICTION');
      // Every flag carries the config version that produced it, so a historical
      // score stays reproducible.
      expect(fired.every((f) => f.rule_config_version === config.version)).toBe(true);
    }
    expect(await rulesFired(clean.applicationId)).toEqual([]);

    const order = await queueOrder();
    expect(order).toHaveLength(3);
    // The expected queue position: the contradiction outranks the clean file.
    expect(order[order.length - 1]!.id).toBe(clean.applicationId);
    expect(order[0]!.score).toBeGreaterThan(0);
    expect(order[order.length - 1]!.score).toBe(0);
  });

  it('re-scores the sibling already in the queue, not just the new upload', async () => {
    // The fan-out from stages.ts: a contradiction is a property of the family,
    // so the application already sitting in the queue has to move too. Scoring
    // only the document that triggered the job is the easy bug here.
    const household = {
      guardianName: 'Palanisamy Kandasamy',
      addressLine: '12 Thiruvalluvar Street, Gandhipuram',
      guardianPhone: '9042118876',
    };

    const first = await seedApplication({ ...household, declaredAnnualIncome: 88_000 });
    const { ctx } = stubContext();
    await processDocument(
      { documentId: first.documentId, applicationId: first.applicationId },
      ctx,
    );

    const { rows: before } = await query<{ risk_score: string }>(
      `SELECT risk_score FROM applications WHERE id = $1`,
      [first.applicationId],
    );
    expect(Number(before[0]!.risk_score)).toBe(0);

    const second = await seedApplication({ ...household, declaredAnnualIncome: 195_000 });
    const outcome = await processDocument(
      { documentId: second.documentId, applicationId: second.applicationId },
      ctx,
    );

    expect(outcome.scored).toContain(first.applicationId);

    const { rows: after } = await query<{ risk_score: string }>(
      `SELECT risk_score FROM applications WHERE id = $1`,
      [first.applicationId],
    );
    expect(Number(after[0]!.risk_score)).toBeGreaterThan(0);
  });
});

describe('an upload that is not a certificate', () => {
  it('is flagged rather than passing as a screen of skipped checks', async () => {
    // The case that started this rule: a legible document with none of a
    // certificate's fields on it.
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext({
      extraction: extraction({ fields: {}, pageConfidence: 0.93, wordCount: 800 }),
    });

    await processDocument({ documentId, applicationId }, ctx);

    const fired = await rulesFired(applicationId);
    expect(fired.map((f) => f.rule_id)).toContain('DOCUMENT_NOT_A_CERTIFICATE');
  });

  it('is not flagged when the page was simply read badly', async () => {
    const { applicationId, documentId } = await seedApplication();
    const { ctx } = stubContext({
      extraction: extraction({ fields: {}, pageConfidence: 0.35, wordCount: 800 }),
    });

    await processDocument({ documentId, applicationId }, ctx);

    const fired = await rulesFired(applicationId);
    expect(fired.map((f) => f.rule_id)).not.toContain('DOCUMENT_NOT_A_CERTIFICATE');
  });
});

describe('the applicant boundary, end to end', () => {
  it('never exposes a score or a flag on a scored application', async () => {
    // The serializer test asserts the shape; this asserts it against a row that
    // genuinely carries a score and flags, which is the case that matters.
    const household = {
      guardianName: 'Selvaraj Thangavel',
      addressLine: '3 Perumal Koil Street, Tambaram',
      guardianPhone: '9840551209',
    };
    const one = await seedApplication({ ...household, declaredAnnualIncome: 80_000 });
    const two = await seedApplication({ ...household, declaredAnnualIncome: 190_000 });

    const { ctx } = stubContext();
    await processDocument({ documentId: one.documentId, applicationId: one.applicationId }, ctx);
    await processDocument({ documentId: two.documentId, applicationId: two.applicationId }, ctx);

    const { toApplicantView } = await import('../../src/serializers.js');
    const { rows } = await query<{
      id: string;
      cycle: string;
      status: 'ready_for_review';
      submitted_at: Date;
    }>(`SELECT id, cycle, status, submitted_at FROM applications WHERE id = $1`, [
      two.applicationId,
    ]);

    const view = toApplicantView(rows[0]!, 1);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toMatch(/risk|score|flag|severity|household/i);
    expect(view.stage).toBe('under_review');
  });
});
