import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { recordAudit } from '../audit.js';
import { verifyPassword } from '../auth/passwords.js';
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

  // Always the same response, so this endpoint cannot enumerate applicants.
  // In development the token is returned directly; there is no mail transport yet.
  const body: Record<string, unknown> = {
    status: 'sent',
    message: 'If that address is valid, a sign-in link has been sent.',
  };
  if (config.NODE_ENV !== 'production') body.devToken = token;

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

authRouter.get('/me', (req, res) => {
  if (!req.session) {
    res.status(401).json({ error: 'unauthorized', message: 'No session.' });
    return;
  }
  res.json(req.session);
});
