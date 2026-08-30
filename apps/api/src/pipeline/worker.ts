/**
 * The pipeline worker.
 *
 * Runs the five stages in order for one document, each through `runStage` so
 * that redelivery cannot double-write. The chain is expressed as a plain
 * sequence rather than a state machine because it is a sequence: there are no
 * branches, and the only conditional is "did the previous stage produce what the
 * next one needs".
 *
 * WHAT HAPPENS WHEN A STAGE FAILS
 * -------------------------------
 * Processing stops at the failed stage and the job throws, so BullMQ retries it
 * with backoff. On redelivery the stages that already succeeded skip themselves
 * and work resumes at the failure — the point of persisting results per stage
 * rather than at the end.
 *
 * A stage that has exhausted its attempts is dead-lettered, and the job does NOT
 * throw. Retrying a dead-lettered document forever would bury the queue in work
 * that needs a human; it surfaces in the admin dead-letter list instead.
 */

import { Worker, type Job } from 'bullmq';

import { recordAudit } from '../audit.js';
import { query } from '../db.js';
import { s3DocumentLoader } from '../storage.js';
import * as ocrClient from './ocrClient.js';
import { connection, DOCUMENT_QUEUE, type DocumentJob } from './queue.js';
import * as stages from './stages.js';
import { runStage, type StageOutcome } from './stageRunner.js';

/** How many documents one worker process handles at once. */
const CONCURRENCY = 2;

export const defaultContext: stages.StageContext = {
  loadDocument: s3DocumentLoader,
  ocr: ocrClient,
};

class StageFailure extends Error {
  constructor(stage: string, cause: string) {
    super(`stage ${stage} failed: ${cause}`);
    this.name = 'StageFailure';
  }
}

export interface PipelineOutcome {
  documentId: string;
  completed: string[];
  stoppedAt: string | null;
  deadLettered: boolean;
  scored: string[];
}

/**
 * Run the whole chain for one document.
 *
 * Exported separately from the Worker so it can be driven directly — by tests,
 * and by `npm run pipeline:run` for a document that needs reprocessing without
 * a Redis round trip.
 */
export async function processDocument(
  job: DocumentJob,
  ctx: stages.StageContext = defaultContext,
): Promise<PipelineOutcome> {
  const { documentId } = job;
  const completed: string[] = [];

  await query(
    `UPDATE applications SET status = 'processing'
      WHERE id = $1 AND status = 'submitted'`,
    [job.applicationId],
  );

  const check = (stage: string, outcome: StageOutcome<unknown>): boolean => {
    if (outcome.status === 'succeeded') {
      completed.push(stage);
      return true;
    }
    if (outcome.status === 'dead_lettered') return false;
    // `ran: false` with a non-terminal status means another worker holds the
    // stage. Stopping without throwing lets that worker finish the chain.
    if (!outcome.ran) return false;
    throw new StageFailure(stage, outcome.error ?? 'unknown');
  };

  const extraction = await runStage(documentId, 'ocr_extract', () =>
    stages.ocrExtract(documentId, ctx),
  );
  if (!check('ocr_extract', extraction)) {
    return terminal(documentId, completed, 'ocr_extract', extraction);
  }

  const forensics = await runStage(documentId, 'forensics_analyze', () =>
    stages.forensicsAnalyze(documentId, ctx),
  );
  if (!check('forensics_analyze', forensics)) {
    return terminal(documentId, completed, 'forensics_analyze', forensics);
  }

  const verification = await runStage(documentId, 'verification_check', () =>
    stages.verificationCheck(documentId),
  );
  if (!check('verification_check', verification)) {
    return terminal(documentId, completed, 'verification_check', verification);
  }

  const reconcile = await runStage(documentId, 'household_reconcile', () =>
    stages.householdReconcile(documentId),
  );
  if (!check('household_reconcile', reconcile)) {
    return terminal(documentId, completed, 'household_reconcile', reconcile);
  }

  // The fan-out: score every application in the affected household, not just
  // the one that was uploaded. See the header of stages.ts.
  const rescore = (reconcile.result as stages.ReconcileResult | null)?.rescore ?? [
    job.applicationId,
  ];

  const scoring = await runStage(documentId, 'risk_score', () =>
    stages.riskScore(documentId, rescore),
  );
  if (!check('risk_score', scoring)) {
    return terminal(documentId, completed, 'risk_score', scoring);
  }

  return {
    documentId,
    completed,
    stoppedAt: null,
    deadLettered: false,
    scored: (scoring.result as stages.ScoreResult | null)?.scored ?? [],
  };
}

function terminal(
  documentId: string,
  completed: string[],
  stage: string,
  outcome: StageOutcome<unknown>,
): PipelineOutcome {
  return {
    documentId,
    completed,
    stoppedAt: stage,
    deadLettered: outcome.status === 'dead_lettered',
    scored: [],
  };
}

export function startWorker(): Worker<DocumentJob> {
  const worker = new Worker<DocumentJob>(
    DOCUMENT_QUEUE,
    async (job: Job<DocumentJob>) => processDocument(job.data),
    { connection, concurrency: CONCURRENCY },
  );

  worker.on('failed', (job, err) => {
    console.error(`[pipeline] job ${job?.id} failed:`, err.message);
  });

  worker.on('completed', (job, result: PipelineOutcome) => {
    if (result.deadLettered) {
      console.warn(
        `[pipeline] document ${result.documentId} dead-lettered at ${result.stoppedAt}`,
      );
      return;
    }
    if (result.stoppedAt) {
      console.log(
        `[pipeline] document ${result.documentId} paused at ${result.stoppedAt} (held elsewhere)`,
      );
      return;
    }
    console.log(
      `[pipeline] document ${result.documentId} complete; scored ${result.scored.length} application(s)`,
    );
  });

  worker.on('error', (err) => {
    console.error('[pipeline] worker error:', err.message);
  });

  void recordAudit({
    actorId: null,
    actorType: 'system',
    action: 'pipeline.worker.started',
    entityType: 'worker',
    entityId: DOCUMENT_QUEUE,
  }).catch(() => {
    // The worker starting is worth recording, but a database hiccup at boot
    // must not stop it from processing.
  });

  return worker;
}
