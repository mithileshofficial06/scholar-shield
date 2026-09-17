/**
 * Reviewer control over household resolution.
 *
 * Entity resolution produces false merges — common names in Indian datasets are
 * genuinely ambiguous, and no threshold removes that (PROJECT_REPORT.md §14).
 * That is why a household contradiction is a flag with a visible graph rather
 * than a determination: the reviewer can see the edges and reject one.
 *
 * A rejection has to survive the next run of the resolver, or it is cosmetic.
 * It is stored on the edge, honoured by the reconciler, and the cycle is
 * re-resolved and re-scored immediately — so the flags that depended on the
 * rejected merge disappear rather than lingering until the next upload.
 */

import { Router } from 'express';
import { z } from 'zod';

import { recordAudit } from '../audit.js';
import { requireStaff } from '../auth/middleware.js';
import { query } from '../db.js';
import { rescoreCycle } from './applications.js';

export const householdsRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const reasonSchema = z.object({ reason: z.string().trim().min(8).max(500) });

async function edgeCycle(edgeId: string): Promise<string | null> {
  const { rows } = await query<{ cycle: string }>(
    `SELECT a.cycle
       FROM household_edges e
       JOIN applications a ON a.id = e.application_a_id
      WHERE e.id = $1`,
    [edgeId],
  );
  return rows[0]?.cycle ?? null;
}

/** Reject a merge the resolver proposed. */
householdsRouter.post('/edges/:id/reject', requireStaff(), async (req, res) => {
  const params = idParam.safeParse(req.params);
  const body = reasonSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'A reason of at least 8 characters is required to reject a match.',
    });
    return;
  }

  const reviewerId = req.session!.sub;
  const cycle = await edgeCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: 'not_found', message: 'No such household edge.' });
    return;
  }

  const { rowCount } = await query(
    `UPDATE household_edges
        SET rejected_at = now(), rejected_by = $2, rejected_reason = $3
      WHERE id = $1 AND rejected_at IS NULL`,
    [params.data.id, reviewerId, body.data.reason],
  );

  if (rowCount === 0) {
    res.status(409).json({ error: 'already_rejected', message: 'That match is already rejected.' });
    return;
  }

  await recordAudit({
    actorId: reviewerId,
    actorType: 'user',
    action: 'household.edge_rejected',
    entityType: 'household_edge',
    entityId: params.data.id,
    detail: { reason: body.data.reason, cycle },
  });

  const result = await rescoreCycle(cycle, reviewerId);
  res.json({
    status: 'rejected',
    cycle,
    rescored: result.scored.scored.length,
    householdCount: result.reconcile.componentCount,
  });
});

/** Restore a rejection — reviewers are allowed to change their minds. */
householdsRouter.post('/edges/:id/restore', requireStaff(), async (req, res) => {
  const params = idParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad edge id.' });
    return;
  }

  const reviewerId = req.session!.sub;
  const cycle = await edgeCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: 'not_found', message: 'No such household edge.' });
    return;
  }

  const { rowCount } = await query(
    `UPDATE household_edges
        SET rejected_at = NULL, rejected_by = NULL, rejected_reason = NULL
      WHERE id = $1 AND rejected_at IS NOT NULL`,
    [params.data.id],
  );

  if (rowCount === 0) {
    res.status(409).json({ error: 'not_rejected', message: 'That match is not rejected.' });
    return;
  }

  await recordAudit({
    actorId: reviewerId,
    actorType: 'user',
    action: 'household.edge_restored',
    entityType: 'household_edge',
    entityId: params.data.id,
    detail: { cycle },
  });

  const result = await rescoreCycle(cycle, reviewerId);
  res.json({
    status: 'restored',
    cycle,
    rescored: result.scored.scored.length,
    householdCount: result.reconcile.componentCount,
  });
});
