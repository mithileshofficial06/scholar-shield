/**
 * Document retention (PROJECT_REPORT.md §10).
 *
 * "Documents are purged a configured interval after an application reaches a
 * terminal decision" was a promise with no code behind it. A retention policy
 * nobody executes is worse than none, because it is quoted in a privacy notice.
 *
 * WHAT IS DELETED AND WHAT SURVIVES
 * ---------------------------------
 * The bytes go — the object in storage, the OCR extraction, the forensics
 * report, the ELA heatmap. The row stays, carrying `sha256` and `purged_at`, so
 * a past decision is still traceable to a specific file without retaining the
 * file itself. The audit log records the purge, and it cannot be edited.
 *
 * The clock starts at the decision, not at upload: an application still under
 * review needs its document, however old.
 *
 * Runs in the worker process rather than the API, for the same reason OCR does:
 * it is slow, periodic, and nobody's HTTP request should wait for it.
 */

import { recordAudit } from '../audit.js';
import { config } from '../config.js';
import { query } from '../db.js';
import * as storage from '../storage.js';

export interface PurgeResult {
  examined: number;
  purged: number;
  failed: number;
}

interface PurgeableRow {
  id: string;
  storage_key: string;
  ela_heatmap_key: string | null;
  application_id: string;
  decided_at: Date;
}

/** Documents whose application was decided longer ago than the retention window. */
export async function purgeableDocuments(): Promise<PurgeableRow[]> {
  const { rows } = await query<PurgeableRow>(
    `SELECT d.id, d.storage_key, d.ela_heatmap_key, d.application_id, r.decided_at
       FROM documents d
       JOIN applications a ON a.id = d.application_id
       JOIN LATERAL (
         SELECT max(created_at) AS decided_at
           FROM reviews WHERE application_id = a.id
       ) r ON true
      WHERE d.purged_at IS NULL
        AND a.status IN ('approved', 'rejected')
        AND r.decided_at IS NOT NULL
        AND r.decided_at < now() - ($1 || ' days')::interval
      ORDER BY r.decided_at ASC
      LIMIT 500`,
    [String(config.DOCUMENT_RETENTION_DAYS)],
  );
  return rows;
}

export async function runRetention(): Promise<PurgeResult> {
  const documents = await purgeableDocuments();
  let purged = 0;
  let failed = 0;

  for (const document of documents) {
    try {
      await storage.remove(document.storage_key);
      if (document.ela_heatmap_key) await storage.remove(document.ela_heatmap_key);
    } catch (err) {
      // Storage refused. Leave purged_at null so the next run tries again —
      // marking it purged here would leave the bytes in place while the record
      // claimed otherwise, which is the one outcome worth avoiding.
      failed += 1;
      console.error(`[retention] could not delete ${document.storage_key}:`, err);
      continue;
    }

    await query(
      `UPDATE documents
          SET purged_at = now(),
              extracted_fields = NULL,
              forensics = NULL,
              ela_heatmap_key = NULL
        WHERE id = $1`,
      [document.id],
    );

    await recordAudit({
      actorId: null,
      actorType: 'system',
      action: 'document.purged',
      entityType: 'document',
      entityId: document.id,
      detail: {
        applicationId: document.application_id,
        retentionDays: config.DOCUMENT_RETENTION_DAYS,
        decidedAt: new Date(document.decided_at).toISOString(),
      },
    });

    purged += 1;
  }

  if (documents.length > 0) {
    console.log(`[retention] examined ${documents.length}, purged ${purged}, failed ${failed}`);
  }

  return { examined: documents.length, purged, failed };
}

/** Every six hours: often enough to be a policy, rarely enough to be invisible. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startRetentionSchedule(intervalMs = RETENTION_INTERVAL_MS): NodeJS.Timeout {
  void runRetention().catch((err) => console.error('[retention] first run failed:', err));

  const timer = setInterval(() => {
    void runRetention().catch((err) => console.error('[retention] run failed:', err));
  }, intervalMs);

  // Never hold the process open on this timer alone.
  timer.unref();
  return timer;
}
