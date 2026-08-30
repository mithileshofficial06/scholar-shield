/**
 * Pipeline visibility for reviewers (PROJECT_REPORT.md §10).
 *
 * A stage that has exhausted its retries stops and says so rather than failing
 * silently — but that is only true if someone can see it. These routes are what
 * make the dead-letter state visible instead of a row nobody queries.
 *
 * Both routes are staff-only. Nothing here exposes a score or a flag, but the
 * existence and processing state of another applicant's document is not an
 * applicant's business either.
 */

import { Router } from 'express';
import { z } from 'zod';

import { requireStaff } from '../auth/middleware.js';
import { deadLetteredStages, resetDeadLetteredStage } from '../pipeline/stageRunner.js';
import { enqueueDocument } from '../pipeline/queue.js';
import { query } from '../db.js';

export const pipelineRouter = Router();

/** Stages that gave up and need a human. */
pipelineRouter.get('/dead-letters', requireStaff(), async (_req, res) => {
  res.json({ items: await deadLetteredStages() });
});

const retrySchema = z.object({
  documentId: z.string().uuid(),
  stage: z.enum([
    'ocr_extract',
    'forensics_analyze',
    'verification_check',
    'household_reconcile',
    'risk_score',
  ]),
});

/**
 * Clear a dead-lettered stage and re-queue its document.
 *
 * Audited with the reviewer's id, because re-running a stage changes what the
 * queue shows — it is an action with an actor, not a maintenance script.
 */
pipelineRouter.post('/retry', requireStaff(), async (req, res) => {
  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad retry request.' });
    return;
  }

  const { documentId, stage } = parsed.data;
  // requireStaff guarantees a staff session, whose `sub` is the user id.
  const actorId = req.session!.sub;

  const cleared = await resetDeadLetteredStage(documentId, stage, actorId);
  if (!cleared) {
    res.status(404).json({
      error: 'not_found',
      message: 'No dead-lettered stage matches that document and stage.',
    });
    return;
  }

  const { rows } = await query<{ application_id: string }>(
    `SELECT application_id FROM documents WHERE id = $1`,
    [documentId],
  );
  const applicationId = rows[0]?.application_id;
  if (applicationId) {
    await enqueueDocument({ documentId, applicationId });
  }

  res.json({ status: 'requeued', documentId, stage });
});
