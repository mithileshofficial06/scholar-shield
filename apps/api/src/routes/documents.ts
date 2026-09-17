/**
 * Document access for reviewers.
 *
 * The bucket is private and nothing here returns a public URL. A reviewer gets
 * a signed URL with a short life, because a signed URL that outlives the review
 * session is a public URL with extra steps (PROJECT_REPORT.md §10).
 *
 * Applicants have no route into this file at all. They uploaded the document;
 * they have no reason to fetch it back through the reviewer's path, and the
 * extracted fields attached to it are not theirs to see.
 */

import { Router } from 'express';
import { z } from 'zod';

import { recordAudit } from '../audit.js';
import { requireStaff } from '../auth/middleware.js';
import { query } from '../db.js';
import * as storage from '../storage.js';

export const documentsRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

documentsRouter.get('/:id/url', requireStaff(), async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad document id.' });
    return;
  }

  const { rows } = await query<{
    storage_key: string;
    content_type: string;
    purged_at: Date | null;
    application_id: string;
  }>(
    `SELECT storage_key, content_type, purged_at, application_id
       FROM documents WHERE id = $1`,
    [parsed.data.id],
  );

  const document = rows[0];
  if (!document) {
    res.status(404).json({ error: 'not_found', message: 'No such document.' });
    return;
  }

  // A purged document is gone on purpose. Say so, rather than handing back a
  // signed URL that will 404 at the storage layer and look like a bug.
  if (document.purged_at) {
    res.status(410).json({
      error: 'purged',
      message: 'This document was purged under the retention policy. Its hash remains in the audit log.',
    });
    return;
  }

  const url = await storage.signedReadUrl(document.storage_key);

  await recordAudit({
    actorId: req.session!.sub,
    actorType: 'user',
    action: 'document.viewed',
    entityType: 'document',
    entityId: parsed.data.id,
    detail: { applicationId: document.application_id },
  });

  res.json({ url, contentType: document.content_type, expiresInSeconds: 300 });
});
