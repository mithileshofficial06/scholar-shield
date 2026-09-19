import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { magicLinkMessage, sendMail } from '../mail.js';
import { query, withTransaction } from '../db.js';
import { recordAudit } from '../audit.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createMagicLinkToken,
  hashToken,
  issueSession,
  magicLinkExpiry,
} from '../auth/tokens.js';
import { config } from '../config.js';
import type { UserRole } from '@scholarshield/shared';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // JSON like every other error here. The default is a plain-text body, which
  // the sign-in forms cannot parse and so report as the service being down.
  message: {
    error: 'rate_limited',
    message: 'Too many sign-in attempts from this address. Wait a few minutes and try again.',
  },
});

// ---------------------------------------------------------------- staff login

const staffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

interface UserRow {
  id: string;
  role: UserRole;
  password_hash: string | null;
  password_salt: string | null;
  activated_at: Date | null;
}

authRouter.post('/staff/login', loginLimiter, async (req, res) => {
  const parsed = staffLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Email and password required.' });
    return;
  }

  const { rows } = await query<UserRow>(
    `SELECT id, role, password_hash, password_salt, activated_at
       FROM users WHERE lower(email) = lower($1)`,
    [parsed.data.email],
  );

  const user = rows[0];
  // Same response whether the account is missing, unactivated, or the password is
  // wrong — no oracle for which staff emails exist.
  const invalid = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };

  if (!user || !user.password_hash || !user.password_salt || !user.activated_at) {
    res.status(401).json(invalid);
    return;
  }

  const ok = await verifyPassword(parsed.data.password, user.password_hash, user.password_salt);
  if (!ok) {
    res.status(401).json(invalid);
    return;
  }

  const token = issueSession({ kind: 'staff', sub: user.id, role: user.role });
  await recordAudit({
    actorId: user.id,
    actorType: 'user',
    action: 'staff.login',
    entityType: 'user',
    entityId: user.id,
  });

  res.json({ token, role: user.role, expiresInHours: config.SESSION_TTL_HOURS });
});

// ---------------------------------------------------------------- applicant magic link

const magicLinkRequestSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(120),
});

authRouter.post('/applicant/request-link', loginLimiter, async (req, res) => {
  const parsed = magicLinkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Email and full name required.' });
    return;
  }

  const { token, tokenHash } = createMagicLinkToken();

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO applicants (email, full_name)
       VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [parsed.data.email, parsed.data.fullName],
    );
    const applicantId = rows[0]!.id;

    await client.query(
      `INSERT INTO magic_link_tokens (applicant_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [applicantId, tokenHash, magicLinkExpiry()],
    );

    await recordAudit(
      {
        actorId: applicantId,
        actorType: 'applicant',
        action: 'applicant.magic_link_requested',
        entityType: 'applicant',
        entityId: applicantId,
      },
      client,
    );
  });

  const delivery = await sendMail(magicLinkMessage(parsed.data.email, token));

  // Always the same response, so this endpoint cannot enumerate applicants.
  const body: Record<string, unknown> = {
    status: 'sent',
    message: 'If that address is valid, a sign-in link has been sent.',
  };
  // Only when mail genuinely has nowhere to go, and never in production: the
  // local stack has no SMTP server, and a link nobody can reach is not a demo.
  if (config.NODE_ENV !== 'production' && delivery.via === 'log') body.devToken = token;

  res.json(body);
});

const magicLinkConsumeSchema = z.object({ token: z.string().min(10) });

authRouter.post('/applicant/consume-link', loginLimiter, async (req, res) => {
  const parsed = magicLinkConsumeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Token required.' });
    return;
  }

  const tokenHash = hashToken(parsed.data.token);

  const session = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; applicant_id: string }>(
      `SELECT id, applicant_id FROM magic_link_tokens
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;

    // Single use.
    await client.query(`UPDATE magic_link_tokens SET consumed_at = now() WHERE id = $1`, [row.id]);

    await recordAudit(
      {
        actorId: row.applicant_id,
        actorType: 'applicant',
        action: 'applicant.magic_link_consumed',
        entityType: 'applicant',
        entityId: row.applicant_id,
      },
      client,
    );

    return row.applicant_id;
  });

  if (!session) {
    res.status(401).json({ error: 'invalid_token', message: 'That link is invalid or expired.' });
    return;
  }

  const token = issueSession({ kind: 'applicant', sub: session, applicationId: null });
  res.json({ token, expiresInHours: config.SESSION_TTL_HOURS });
});

// ------------------------------------------------------------ invitations

const acceptInviteSchema = z.object({
  token: z.string().min(10),
  // Long rather than complex: length is what actually resists guessing, and a
  // symbol rule mostly produces Password1! on a sticky note.
  password: z.string().min(12).max(200),
});

/**
 * Accept an invitation and set a password.
 *
 * Public, because the invitee has no session yet — the emailed token is the
 * credential. It is stored hashed and consumed here, so a leaked database
 * backup cannot be replayed into an account.
 */
authRouter.post('/accept-invite', loginLimiter, async (req, res) => {
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'A valid invitation token and a password of at least 12 characters are required.',
    });
    return;
  }

  const { hash, salt } = await hashPassword(parsed.data.password);

  const { rows } = await query<{ id: string; role: UserRole; email: string }>(
    `UPDATE users
        SET password_hash = $2, password_salt = $3, activated_at = now(),
            invite_token = NULL, invite_expires_at = NULL
      WHERE invite_token = $1
        AND activated_at IS NULL
        AND invite_expires_at > now()
      RETURNING id, role, email`,
    [hashToken(parsed.data.token), hash, salt],
  );

  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: 'invalid_token', message: 'That invitation is invalid or expired.' });
    return;
  }

  await recordAudit({
    actorId: user.id,
    actorType: 'user',
    action: 'user.invite_accepted',
    entityType: 'user',
    entityId: user.id,
    detail: { role: user.role },
  });

  const token = issueSession({ kind: 'staff', sub: user.id, role: user.role });
  res.json({ token, role: user.role, email: user.email, expiresInHours: config.SESSION_TTL_HOURS });
});

authRouter.get('/me', (req, res) => {
  if (!req.session) {
    res.status(401).json({ error: 'unauthorized', message: 'No session.' });
    return;
  }
  res.json(req.session);
});
