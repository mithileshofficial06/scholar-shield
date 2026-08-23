import type { PoolClient } from 'pg';
import { pool } from './db.js';

/**
 * Append-only audit trail (PROJECT_REPORT.md §4.4).
 *
 * There is deliberately no update or delete helper in this module. The database
 * rejects both via trigger regardless, but the absence of a function to call is
 * the first line of that guarantee.
 */
export interface AuditEntry {
  actorId: string | null;
  actorType: 'user' | 'applicant' | 'system';
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

export async function recordAudit(
  entry: AuditEntry,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_log (actor_id, actor_type, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorId,
      entry.actorType,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
