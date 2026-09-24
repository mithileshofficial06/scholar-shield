/**
 * The stuck-document sweep.
 *
 * A document can fall out of the pipeline without ever reaching a state the
 * admin console shows:
 *
 *   - the submission committed, then Redis was down when it was enqueued, so no
 *     job exists at all;
 *   - a job ran out of BullMQ deliveries, or was lost with its Redis, while a
 *     stage sat in `failed` or `running` with attempts left.
 *
 * Either way the application waited in `submitted` or `processing` forever. The
 * dead-letter list only shows stages that gave up, so nothing surfaced it.
 *
 * This finds documents whose chain is neither finished nor dead-lettered and
 * enqueues them again. That is always safe: enqueueDocument collapses into a
 * job that is still waiting or running, and every stage is idempotent, so a
 * document that was merely slow is not processed twice.
 */

import { query } from '../db.js';
import { enqueueDocument } from './queue.js';
import { STAGE_ORDER } from './stages.js';

/** Younger than this, a document is presumed to be on its way through normally. */
const GRACE_MINUTES = 10;

export interface SweepResult {
  requeued: number;
  failed: number;
}

export async function sweepStuckDocuments(): Promise<SweepResult> {
  const { rows } = await query<{ document_id: string; application_id: string }>(
    `SELECT d.id AS document_id, d.application_id
       FROM documents d
       JOIN applications a ON a.id = d.application_id
       LEFT JOIN pipeline_stage_runs r ON r.document_id = d.id
      WHERE d.purged_at IS NULL
        AND a.status IN ('submitted', 'processing')
        AND d.created_at < now() - ($1 || ' minutes')::interval
      GROUP BY d.id, d.application_id
     HAVING count(*) FILTER (WHERE r.status = 'dead_lettered') = 0
        AND count(*) FILTER (WHERE r.status = 'succeeded') < $2
        -- A stage updated recently is somebody's live work, not a stuck one.
        AND coalesce(max(greatest(r.started_at, r.finished_at)), '-infinity') < now() - ($1 || ' minutes')::interval
      LIMIT 100`,
    [String(GRACE_MINUTES), STAGE_ORDER.length],
  );

  let requeued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await enqueueDocument({ documentId: row.document_id, applicationId: row.application_id });
      requeued += 1;
    } catch (err) {
      failed += 1;
      console.error(`[sweep] could not enqueue ${row.document_id}:`, err);
    }
  }

  if (rows.length > 0) console.log(`[sweep] requeued ${requeued} stuck document(s), ${failed} failed`);
  return { requeued, failed };
}

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startSweepSchedule(intervalMs = SWEEP_INTERVAL_MS): NodeJS.Timeout {
  void sweepStuckDocuments().catch((err) => console.error('[sweep] first run failed:', err));

  const timer = setInterval(() => {
    void sweepStuckDocuments().catch((err) => console.error('[sweep] run failed:', err));
  }, intervalMs);

  // Never hold the process open on this timer alone.
  timer.unref();
  return timer;
}
