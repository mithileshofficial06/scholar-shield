/**
 * The anonymous tip line (PROJECT_REPORT.md §10).
 *
 * The `tips` table, its indexes and its abuse columns have been in 001_init.sql
 * since the schema was written, and nothing ever read or wrote them. The report
 * listed the tip form as a deliverable. This is that route.
 *
 * ANONYMOUS MEANS ANONYMOUS
 * -------------------------
 * No session is required and none is read. The submitter's address is hashed
 * with a server secret before it touches the database, and the raw value is
 * never stored, logged or returned — the column exists for rate limiting and
 * for reviewing abuse, which a salted hash serves as well as an address would.
 *
 * WHY A TIP IS NOT A FLAG
 * -----------------------
 * A tip writes a `tips` row and nothing else. It does not touch `risk_flags`,
 * it does not change a risk score, and it does not move an application in the
 * queue. This is not an oversight to be corrected later: an anonymous accusation
 * that silently reorders a queue is a denunciation box, and the person accused
 * has no way to know it happened or to answer it. A reviewer reads tips on the
 * application, attributed to nothing, and decides what they are worth.
 *
 * WHAT THE SUBMITTER IS TOLD
 * --------------------------
 * The response is identical whether or not the application id exists. Otherwise
 * the form is an oracle for "does this person have an application in this
 * cycle", which is exactly the fact an applicant is entitled to keep.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { requireStaff } from '../auth/middleware.js';
import { recordAudit } from '../audit.js';
import { config } from '../config.js';
import { query } from '../db.js';

export const tipsRouter = Router();

/**
 * Salted with JWT_SECRET so the hashes are not a rainbow table of every IP that
 * ever visited. A bare sha256 of an IPv4 address is reversible by brute force in
 * seconds — there are only four billion of them.
 */
export function hashSubmitter(ip: string): string {
  return createHash('sha256').update(`${config.JWT_SECRET}:${ip}`).digest('hex');
}

const tipLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'rate_limited',
    message: 'Too many tips from this address. Try again later.',
  },
});

const tipSchema = z.object({
  // Optional: a tip about a cycle in general is still worth having, and
  // demanding an application id would make the form useless to anyone who does
  // not already know one.
  applicationId: z.string().uuid().optional(),
  body: z
    .string()
    .trim()
    .min(10, 'Tell us what you saw — at least 10 characters.')
    .max(2000),
});

tipsRouter.post('/', tipLimiter, async (req, res) => {
  const parsed = tipSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'A tip of between 10 and 2000 characters is required.',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { applicationId, body } = parsed.data;

  // Checked rather than left to the foreign key, so an unknown id becomes a tip
  // with no application attached instead of a 500 — and so the response below
  // can stay identical either way.
  let attachedTo: string | null = null;
  if (applicationId) {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM applications WHERE id = $1',
      [applicationId],
    );
    attachedTo = rows[0]?.id ?? null;
  }

  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO tips (application_id, body, submitter_ip_hash)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [attachedTo, body, hashSubmitter(req.ip ?? 'unknown')],
  );

  // The entity is the tip, not the application: a tip may be attached to no
  // application at all, and audit_log.entity_id is NOT NULL.
  //
  // The row records that a tip arrived, never who sent it and never what it
  // said. The audit log is readable by every admin, and a tip's text sitting in
  // it would undo the anonymity the form promises.
  await recordAudit({
    actorId: null,
    actorType: 'system',
    action: 'tip.received',
    entityType: 'tip',
    entityId: inserted[0]!.id,
    detail: { attachedApplicationId: attachedTo, length: body.length },
  });

  // Deliberately the same answer for a real id, an unknown id and no id at all.
  res.status(201).json({
    received: true,
    message: 'Thank you. A reviewer will see this. You will not be contacted.',
  });
});

/* ------------------------------------------------------------ reviewer side */

interface TipRow {
  id: string;
  body: string;
  created_at: Date;
  marked_abusive_at: Date | null;
}

/** Tips attached to one application, for the reviewer's detail page. */
tipsRouter.get('/application/:id', requireStaff(), async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad application id.' });
    return;
  }

  const { rows } = await query<TipRow>(
    `SELECT id, body, created_at, marked_abusive_at
       FROM tips
      WHERE application_id = $1
      ORDER BY created_at DESC`,
    [parsed.data],
  );

  // No submitter_ip_hash in the payload. A reviewer has no use for it, and a
  // hash that reaches the browser is a hash that can be correlated across tips.
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: new Date(row.created_at).toISOString(),
      markedAbusive: row.marked_abusive_at !== null,
    })),
  });
});

/**
 * Mark a tip abusive.
 *
 * Not a delete. The row stays, carrying who marked it and when, because a tip
 * used to harass someone is evidence of the harassment and deleting it destroys
 * that. The UI stops showing the body; the record keeps it.
 */
tipsRouter.post('/:id/abusive', requireStaff(), async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad tip id.' });
    return;
  }

  const reviewerId = req.session!.sub;
  const { rows } = await query<{ id: string; application_id: string | null }>(
    `UPDATE tips
        SET marked_abusive_by = $2, marked_abusive_at = now()
      WHERE id = $1 AND marked_abusive_at IS NULL
      RETURNING id, application_id`,
    [parsed.data, reviewerId],
  );

  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: 'not_found', message: 'No such tip, or it is already marked.' });
    return;
  }

  await recordAudit({
    actorId: reviewerId,
    actorType: 'user',
    action: 'tip.marked_abusive',
    entityType: 'tip',
    entityId: row.id,
    detail: { applicationId: row.application_id },
  });

  res.json({ id: row.id, markedAbusive: true });
});
