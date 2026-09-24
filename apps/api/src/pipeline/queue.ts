/**
 * BullMQ wiring (PROJECT_REPORT.md §10).
 *
 * ONE JOB PER DOCUMENT, NOT ONE PER STAGE
 * ---------------------------------------
 * The whole chain runs inside a single job, and each stage claims its own row in
 * `pipeline_stage_runs` before doing work. The alternative — a job per stage,
 * each enqueuing the next — spreads the ordering guarantee across five queues
 * and makes "which stage is this document stuck on" a question you answer by
 * grepping Redis. Here it is one row in Postgres.
 *
 * Because every stage is individually idempotent (see stageRunner.ts), a retry
 * of the whole job re-runs only the stages that have not succeeded. That is what
 * makes a single job safe to retry: the expensive stages skip themselves.
 *
 * RETRY POLICY
 * ------------
 * BullMQ retries with exponential backoff, and the stage runner counts attempts
 * independently in the database. The two are deliberately not the same counter:
 * BullMQ's is about delivery, the database's is about work actually attempted.
 * A job redelivered because a worker was killed before acknowledging has burned
 * a BullMQ attempt without burning a stage attempt, which is correct.
 */

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

import { config } from '../config.js';

export const DOCUMENT_QUEUE = 'document-pipeline';

export interface DocumentJob {
  documentId: string;
  applicationId: string;
}

export const connection: ConnectionOptions = {
  url: config.REDIS_URL,
  // BullMQ requires this: with a finite retry count a blocking command can
  // reject mid-wait and kill the worker instead of reconnecting.
  maxRetriesPerRequest: null,
};

/** Stages in the chain, and attempts each gets before it is dead-lettered. */
const STAGE_COUNT = 5;
const ATTEMPTS_PER_STAGE = 4; // stageRunner.MAX_ATTEMPTS

export const defaultJobOptions: JobsOptions = {
  // One job carries all five stages, and BullMQ's counter is per job while the
  // database's is per stage. With the old budget of 5, a flaky OCR stage that
  // took three tries left the next stage two deliveries — fewer than it needs
  // to reach dead-letter — so the job died with the stage merely `failed`:
  // invisible in the admin dead-letter list and never retried. The job budget
  // now covers every stage exhausting its own attempts, so a stage always
  // reaches a terminal state the database records.
  attempts: STAGE_COUNT * ATTEMPTS_PER_STAGE,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep a bounded history: enough to debug a bad afternoon, not enough to
  // grow unbounded in Redis.
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 2_000 },
};

let queue: Queue<DocumentJob> | null = null;

/** Lazily constructed so importing this module never opens a Redis socket —
 * tests and one-shot scripts import the types without needing a server. */
export function documentQueue(): Queue<DocumentJob> {
  if (!queue) {
    queue = new Queue<DocumentJob>(DOCUMENT_QUEUE, {
      connection,
      defaultJobOptions,
    });
  }
  return queue;
}

/**
 * Enqueue a document for processing.
 *
 * The job id is the document id, so a duplicate submission of the same document
 * collapses into one job rather than racing itself through the pipeline. The
 * stage runner would catch it anyway; this stops it from being generated.
 */
export async function enqueueDocument(job: DocumentJob): Promise<void> {
  const queue = documentQueue();

  // BullMQ ignores an add whose id already exists — including a job it is
  // merely keeping in its completed or failed history. A dead-lettered
  // document's job COMPLETES (the worker stops without throwing), so without
  // this, "Retry" reset the stage in the database and then enqueued nothing.
  // A finished job is removed so the new one can take its id; a waiting or
  // active one is left alone, and the add below collapses into it as intended.
  const existing = await queue.getJob(job.documentId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') await existing.remove();
  }

  await queue.add('process', job, { jobId: job.documentId });
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
