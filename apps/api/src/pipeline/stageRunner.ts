/**
 * Idempotent stage execution (PROJECT_REPORT.md §10, "Pipeline semantics").
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * BullMQ delivers at least once. A worker that finishes a stage and dies before
 * acknowledging will be handed the same job again, and a naive handler then
 * writes a second set of risk flags, or re-charges a stage that already ran. So
 * "did this stage already run for this document" has to be a fact in the
 * database, not an assumption about delivery.
 *
 * `pipeline_stage_runs` carries `UNIQUE (document_id, stage)`, and that
 * constraint is the whole mechanism. Every stage claims its row before doing any
 * work; a claim that loses the race does not run.
 *
 * WHY THE CLAIM IS A SINGLE STATEMENT
 * -----------------------------------
 * Checking status and then updating it in two statements is a race: two workers
 * both read `pending`, both proceed, both write. The claim below is one
 * `INSERT ... ON CONFLICT DO UPDATE` with a `WHERE` that only matches rows
 * eligible to run, so the database decides the winner and the loser sees zero
 * rows affected. No advisory lock, no read-then-write.
 *
 * WHAT COUNTS AS ELIGIBLE
 * -----------------------
 * A stage may be claimed when it is pending, when it previously failed and has
 * attempts left, or when it has been running longer than the stale timeout —
 * that last case covers a worker killed mid-stage, whose row would otherwise sit
 * in `running` forever. Succeeded and dead-lettered stages are never re-run:
 * one because the work is done, the other because it needs a human.
 */

import type { PipelineStage } from '@scholarshield/shared';
import type { PoolClient } from 'pg';

import { recordAudit } from '../audit.js';
import { pool, query } from '../db.js';

/**
 * A stage still in `running` after this long is presumed abandoned by a worker
 * that died. Long enough that a slow OCR pass on a large scan is never stolen
 * mid-flight; short enough that a crash does not wedge a document until someone
 * notices.
 */
export const STALE_RUNNING_MS = 5 * 60 * 1000;

/** Attempts before a stage is dead-lettered for a human to look at. */
export const MAX_ATTEMPTS = 4;

export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered';

export interface StageOutcome<T> {
  /** False when another worker already holds or completed this stage. */
  ran: boolean;
  status: StageStatus;
  attempts: number;
  result: T | null;
  error: string | null;
}

interface ClaimRow {
  id: string;
  attempts: number;
}

/**
 * Take ownership of (documentId, stage), or return null if it is not ours.
 *
 * The `WHERE` clause on the conflict branch is what makes this safe under
 * concurrent delivery: only one statement can move a row out of an eligible
 * state, and Postgres serialises them on the unique index.
 */
async function claim(
  documentId: string,
  stage: PipelineStage,
  client: PoolClient,
): Promise<ClaimRow | null> {
  const { rows } = await client.query<ClaimRow>(
    `INSERT INTO pipeline_stage_runs (document_id, stage, status, attempts, started_at)
     VALUES ($1, $2, 'running', 1, now())
     ON CONFLICT (document_id, stage) DO UPDATE
       SET status      = 'running',
           attempts    = pipeline_stage_runs.attempts + 1,
           started_at  = now(),
           finished_at = NULL
       WHERE pipeline_stage_runs.status = 'pending'
          OR (pipeline_stage_runs.status = 'failed'
              AND pipeline_stage_runs.attempts < $3)
          OR (pipeline_stage_runs.status = 'running'
              AND pipeline_stage_runs.started_at < now() - ($4::bigint * interval '1 millisecond'))
     RETURNING id, attempts`,
    [documentId, stage, MAX_ATTEMPTS, STALE_RUNNING_MS],
  );

  return rows[0] ?? null;
}

async function currentState(
  documentId: string,
  stage: PipelineStage,
): Promise<{ status: StageStatus; attempts: number; result: unknown; last_error: string | null } | null> {
  const { rows } = await query<{
    status: StageStatus;
    attempts: number;
    result: unknown;
    last_error: string | null;
  }>(
    `SELECT status, attempts, result, last_error
       FROM pipeline_stage_runs
      WHERE document_id = $1 AND stage = $2`,
    [documentId, stage],
  );
  return rows[0] ?? null;
}

/**
 * Run `work` exactly once for this (document, stage), whatever the queue does.
 *
 * Results are persisted as the stage completes rather than at the end of the
 * chain, so a retry resumes from the failed stage instead of restarting from
 * OCR — which matters because OCR is by far the most expensive step.
 */
export async function runStage<T>(
  documentId: string,
  stage: PipelineStage,
  work: () => Promise<T>,
): Promise<StageOutcome<T>> {
  const client = await pool.connect();
  let claimed: ClaimRow | null;

  try {
    claimed = await claim(documentId, stage, client);
  } finally {
    client.release();
  }

  if (!claimed) {
    // Not an error. Either another worker is on it, or it is already done —
    // which is exactly what at-least-once delivery looks like from here.
    const state = await currentState(documentId, stage);
    return {
      ran: false,
      status: state?.status ?? 'pending',
      attempts: state?.attempts ?? 0,
      result: (state?.result as T) ?? null,
      error: state?.last_error ?? null,
    };
  }

  try {
    const result = await work();

    await query(
      `UPDATE pipeline_stage_runs
          SET status = 'succeeded', result = $2, finished_at = now(), last_error = NULL
        WHERE id = $1`,
      [claimed.id, JSON.stringify(result ?? null)],
    );

    return {
      ran: true,
      status: 'succeeded',
      attempts: claimed.attempts,
      result,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Exhausted attempts go to the dead-letter state, which the admin UI
    // surfaces. A job that fails silently forever is worse than one that stops
    // and says so.
    const exhausted = claimed.attempts >= MAX_ATTEMPTS;
    const status: StageStatus = exhausted ? 'dead_lettered' : 'failed';

    await query(
      `UPDATE pipeline_stage_runs
          SET status = $2, last_error = $3, finished_at = now()
        WHERE id = $1`,
      [claimed.id, status, message.slice(0, 2000)],
    );

    if (exhausted) {
      await recordAudit({
        actorId: null,
        actorType: 'system',
        action: 'pipeline.stage.dead_lettered',
        entityType: 'document',
        entityId: documentId,
        detail: { stage, attempts: claimed.attempts, error: message.slice(0, 500) },
      });
    }

    return {
      ran: true,
      status,
      attempts: claimed.attempts,
      result: null,
      error: message,
    };
  }
}

/** Stages sitting in the dead-letter state, for the admin queue. */
export async function deadLetteredStages(limit = 100): Promise<
  Array<{
    documentId: string;
    applicationId: string;
    stage: PipelineStage;
    attempts: number;
    lastError: string | null;
    finishedAt: string | null;
  }>
> {
  const { rows } = await query<{
    document_id: string;
    application_id: string;
    stage: PipelineStage;
    attempts: number;
    last_error: string | null;
    finished_at: string | null;
  }>(
    `SELECT r.document_id, d.application_id, r.stage, r.attempts, r.last_error, r.finished_at
       FROM pipeline_stage_runs r
       JOIN documents d ON d.id = r.document_id
      WHERE r.status = 'dead_lettered'
      ORDER BY r.finished_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    documentId: row.document_id,
    applicationId: row.application_id,
    stage: row.stage,
    attempts: row.attempts,
    lastError: row.last_error,
    finishedAt: row.finished_at,
  }));
}

/**
 * Clear a dead-lettered stage so it can be retried.
 *
 * Requires a reviewer, and is audited: re-running a stage changes what a
 * reviewer sees, so it is an action with an actor, not a maintenance script.
 */
export async function resetDeadLetteredStage(
  documentId: string,
  stage: PipelineStage,
  actorId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE pipeline_stage_runs
        SET status = 'pending', attempts = 0, last_error = NULL, finished_at = NULL
      WHERE document_id = $1 AND stage = $2 AND status = 'dead_lettered'`,
    [documentId, stage],
  );

  if (!rowCount) return false;

  await recordAudit({
    actorId,
    actorType: 'user',
    action: 'pipeline.stage.reset',
    entityType: 'document',
    entityId: documentId,
    detail: { stage },
  });
  return true;
}
