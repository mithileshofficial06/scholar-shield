import { Router } from 'express';
import { z } from 'zod';

import { limiter } from '../rateLimit.js';

import { magicLinkMessage, sendMail } from '../mail.js';
import { query, withTransaction } from '../db.js';
import { recordAudit } from '../audit.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { requireStaff, staffSessionIsLive } from '../auth/middleware.js';
import {
  generateRecoveryCode,
  generateSecret,
  normalizeRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  verifyCode,
} from '../auth/totp.js';
import { createHash } from 'node:crypto';
import {
  createMagicLinkToken,
  hashToken,
  issueSession,
  magicLinkExpiry,
} from '../auth/tokens.js';
import { config } from '../config.js';
import type { UserRole } from '@scholarshield/shared';
import { rescoreCycle } from './applications.js';

export const authRouter = Router();

const loginLimiter = limiter('login', {
  windowMs: 15 * 60_000,
  limit: 10,
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
  /** Six digits from an authenticator app, when the account has TOTP enrolled. */
  totpCode: z.string().trim().optional(),
  /** One of the codes issued at enrolment, for a lost authenticator. */
  recoveryCode: z.string().trim().optional(),
});

interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  password_hash: string | null;
  password_salt: string | null;
  activated_at: Date | null;
  totp_secret: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
  session_version: number;
  deactivated_at: Date | null;
}

/**
 * A real hash of a password nobody has, computed once. A sign-in for an email
 * with no account is checked against it, so it pays the same scrypt cost as a
 * wrong password: otherwise the response time says which staff emails exist.
 */
const decoyCredential = hashPassword('decoy-password-for-constant-time-login');

/** Recovery codes are hashed like passwords: the server only needs to compare. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

authRouter.post('/staff/login', loginLimiter, async (req, res) => {
  const parsed = staffLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Email and password required.' });
    return;
  }

  const { rows } = await query<UserRow>(
    `SELECT id, email, role, password_hash, password_salt, activated_at,
            totp_secret, totp_enabled_at, totp_last_step, session_version, deactivated_at
       FROM users WHERE lower(email) = lower($1)`,
    [parsed.data.email],
  );

  const user = rows[0];
  // Same response whether the account is missing, unactivated, or the password is
  // wrong — no oracle for which staff emails exist.
  const invalid = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };

  const usable =
    user && user.password_hash && user.password_salt && user.activated_at && !user.deactivated_at
      ? user
      : null;

  // Always run scrypt, against a decoy when there is no usable account, so a
  // missing or deactivated account takes as long to refuse as a wrong password.
  const decoy = await decoyCredential;
  const ok = await verifyPassword(
    parsed.data.password,
    usable ? usable.password_hash! : decoy.hash,
    usable ? usable.password_salt! : decoy.salt,
  );
  if (!user || !usable || !ok) {
    res.status(401).json(invalid);
    return;
  }

  // The second factor, for accounts that have one. Checked after the password
  // so that a wrong password and a wrong code are indistinguishable from the
  // outside: answering "password correct, now the code" to an attacker confirms
  // the password for them.
  if (user.totp_enabled_at && user.totp_secret) {
    const outcome = await verifySecondFactor(user, parsed.data);
    if (!outcome.ok) {
      res.status(401).json(
        outcome.reason === 'missing'
          ? {
              error: 'totp_required',
              message: 'This account uses an authenticator app. Enter the six-digit code.',
            }
          : invalid,
      );
      return;
    }
  }

  const token = issueSession({ kind: 'staff', sub: user.id, role: user.role, sv: user.session_version });
  await recordAudit({
    actorId: user.id,
    actorType: 'user',
    action: 'staff.login',
    entityType: 'user',
    entityId: user.id,
    detail: { secondFactor: user.totp_enabled_at ? 'totp' : 'none' },
  });

  res.json({ token, role: user.role, expiresInHours: config.SESSION_TTL_HOURS });
});

/**
 * Check a TOTP code, or spend a recovery code.
 *
 * A recovery code is consumed in the same statement that checks it — `used_at IS
 * NULL` in the WHERE clause plus RETURNING means two simultaneous attempts
 * cannot both succeed with one code.
 */
async function verifySecondFactor(
  user: UserRow,
  input: { totpCode?: string; recoveryCode?: string },
): Promise<{ ok: boolean; reason?: 'missing' }> {
  if (input.recoveryCode) {
    const { rows } = await query<{ id: string }>(
      `UPDATE totp_recovery_codes
          SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING id`,
      [user.id, hashRecoveryCode(input.recoveryCode)],
    );
    if (rows.length === 0) return { ok: false };

    await recordAudit({
      actorId: user.id,
      actorType: 'user',
      action: 'staff.totp_recovery_used',
      entityType: 'user',
      entityId: user.id,
      detail: { recoveryCodeId: rows[0]!.id },
    });
    return { ok: true };
  }

  if (!input.totpCode) return { ok: false, reason: 'missing' };

  const lastStep = user.totp_last_step === null ? null : Number(user.totp_last_step);
  const result = verifyCode(user.totp_secret!, input.totpCode, lastStep);
  if (!result.ok) return { ok: false };

  // Burn the step so the same code cannot be replayed inside its window. The
  // guard repeats the comparison in SQL because two logins can race here.
  await query(
    `UPDATE users SET totp_last_step = $2
      WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [user.id, result.step],
  );
  return { ok: true };
}


/* ------------------------------------------------------------------ TOTP */

/**
 * Begin enrolment: mint a secret and hand back the URI to scan.
 *
 * The secret is stored immediately but `totp_enabled_at` stays null, so it gates
 * nothing yet. An enrolment abandoned at this point leaves a secret nobody uses
 * and no way to be locked out — which is why confirmation is a separate call.
 *
 * Re-enrolling replaces the secret, which is what someone with a new phone
 * needs. It is refused while TOTP is already on: turning it off first requires
 * a current code, so a hijacked session cannot quietly swap the second factor
 * for one the attacker holds.
 */
authRouter.post('/totp/enrol', requireStaff(), async (req, res) => {
  const userId = req.session!.sub;

  const { rows } = await query<{ email: string; totp_enabled_at: Date | null }>(
    `SELECT email, totp_enabled_at FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'No such user.' });
    return;
  }
  if (user.totp_enabled_at) {
    res.status(409).json({
      error: 'already_enrolled',
      message: 'An authenticator is already set up. Remove it first, which needs a current code.',
    });
    return;
  }

  const secret = generateSecret();
  await query(`UPDATE users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1`, [
    userId,
    secret,
  ]);

  res.json({
    secret,
    otpauthUri: otpauthUri(secret, user.email),
    message: 'Scan this, then confirm with the six-digit code to turn it on.',
  });
});

const confirmSchema = z.object({ code: z.string().trim() });

/**
 * Finish enrolment, and issue the recovery codes.
 *
 * The codes are returned exactly once, here. Only their hashes are stored, so
 * there is no second chance to read them and no support path that can recover
 * one — which is the property that makes them worth having.
 */
authRouter.post('/totp/confirm', requireStaff(), async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'A six-digit code is required.' });
    return;
  }

  const userId = req.session!.sub;
  const { rows } = await query<{ totp_secret: string | null; totp_enabled_at: Date | null }>(
    `SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];

  if (!user?.totp_secret) {
    res.status(409).json({ error: 'not_enrolling', message: 'Start enrolment first.' });
    return;
  }
  if (user.totp_enabled_at) {
    res.status(409).json({ error: 'already_enrolled', message: 'Already turned on.' });
    return;
  }

  // Nothing has been spent yet, so any step in the window is acceptable here.
  const result = verifyCode(user.totp_secret, parsed.data.code, null);
  if (!result.ok) {
    res.status(400).json({
      error: 'invalid_code',
      message: 'That code did not match. Check your phone’s clock and try the current code.',
    });
    return;
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1`,
      [userId, result.step],
    );
    // Replaced wholesale rather than appended: codes from an earlier enrolment
    // belong to a secret that is gone.
    await client.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
    for (const code of codes) {
      await client.query(
        `INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hashRecoveryCode(code)],
      );
    }
    await recordAudit(
      {
        actorId: userId,
        actorType: 'user',
        action: 'staff.totp_enabled',
        entityType: 'user',
        entityId: userId,
        detail: { recoveryCodesIssued: codes.length },
      },
      client,
    );
  });

  res.json({
    enabled: true,
    recoveryCodes: codes,
    message:
      'Save these somewhere safe. Each works once if you lose your authenticator, and they are not shown again.',
  });
});

const disableSchema = z.object({
  code: z.string().trim().optional(),
  recoveryCode: z.string().trim().optional(),
});

/**
 * Turn TOTP off.
 *
 * Requires a current code or a recovery code even though the caller already
 * holds a session: a stolen session should not be able to strip the factor that
 * would have stopped it being useful next time.
 */
authRouter.post('/totp/disable', requireStaff(), async (req, res) => {
  const parsed = disableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'A code is required.' });
    return;
  }

  const userId = req.session!.sub;
  const { rows } = await query<UserRow>(
    `SELECT id, email, role, password_hash, password_salt, activated_at,
            totp_secret, totp_enabled_at, totp_last_step, session_version, deactivated_at
       FROM users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];

  if (!user?.totp_enabled_at || !user.totp_secret) {
    res.status(409).json({ error: 'not_enrolled', message: 'No authenticator is set up.' });
    return;
  }

  const outcome = await verifySecondFactor(user, {
    totpCode: parsed.data.code,
    recoveryCode: parsed.data.recoveryCode,
  });
  if (!outcome.ok) {
    res.status(401).json({ error: 'invalid_code', message: 'That code did not match.' });
    return;
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users
          SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL
        WHERE id = $1`,
      [userId],
    );
    await client.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
    await recordAudit(
      {
        actorId: userId,
        actorType: 'user',
        action: 'staff.totp_disabled',
        entityType: 'user',
        entityId: userId,
      },
      client,
    );
  });

  res.json({ enabled: false });
});

/** Whether this account has TOTP on, and how many recovery codes are left. */
authRouter.get('/totp/status', requireStaff(), async (req, res) => {
  const userId = req.session!.sub;

  const [user, codes] = await Promise.all([
    query<{ totp_enabled_at: Date | null; totp_secret: string | null }>(
      `SELECT totp_enabled_at, totp_secret FROM users WHERE id = $1`,
      [userId],
    ),
    query<{ remaining: string }>(
      `SELECT count(*)::text AS remaining
         FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    ),
  ]);

  const row = user.rows[0];
  res.json({
    enabled: row?.totp_enabled_at !== null && row?.totp_enabled_at !== undefined,
    // An enrolment that was started and never confirmed, so the UI can offer to
    // resume rather than reporting "off" and minting a third secret.
    pending: Boolean(row?.totp_secret) && !row?.totp_enabled_at,
    recoveryCodesRemaining: Number(codes.rows[0]?.remaining ?? 0),
  });
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
    // An unauthenticated caller must not be able to rewrite the stored name of
    // someone else's account, so an existing row is left exactly as it is. A
    // brand-new applicant has not confirmed anything yet.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO applicants (email, full_name, email_confirmed_at)
       VALUES ($1, $2, NULL)
       ON CONFLICT (lower(email)) DO UPDATE SET email = applicants.email
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
  let newlyConfirmed = false;

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

    // Using a link sent to the address proves the address, which is what lets
    // this applicant's applications take part in household resolution.
    const confirmed = await client.query(
      `UPDATE applicants SET email_confirmed_at = now()
        WHERE id = $1 AND email_confirmed_at IS NULL`,
      [row.applicant_id],
    );
    newlyConfirmed = (confirmed.rowCount ?? 0) > 0;

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

  if (newlyConfirmed) {
    // Their applications have just joined the population the rules read, so
    // each of their cycles is resolved and scored again — after the response,
    // because signing in should not wait on a whole cycle's scoring.
    void rescoreApplicantCycles(session).catch((err: unknown) => {
      console.error('[auth] rescore after email confirmation failed', err);
    });
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

  // A freshly activated account has never had its sessions revoked.
  const token = issueSession({ kind: 'staff', sub: user.id, role: user.role, sv: 0 });
  res.json({ token, role: user.role, email: user.email, expiresInHours: config.SESSION_TTL_HOURS });
});

authRouter.get('/me', async (req, res) => {
  if (!req.session) {
    res.status(401).json({ error: 'unauthorized', message: 'No session.' });
    return;
  }
  if (req.session.kind === 'staff') {
    const role = await staffSessionIsLive(req.session.sub, req.session.sv);
    if (!role) {
      res.status(401).json({ error: 'session_revoked', message: 'This session is no longer valid.' });
      return;
    }
    res.json({ ...req.session, role });
    return;
  }
  res.json(req.session);
});

/**
 * Sign out everywhere: every staff token issued so far stops working.
 *
 * Deleting a cookie signs out one browser and leaves the token inside it valid
 * until expiry. Bumping the session version revokes all of them at once.
 */
authRouter.post('/logout-everywhere', requireStaff(), async (req, res) => {
  const userId = req.session!.sub;
  await query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [userId]);
  await recordAudit({
    actorId: userId,
    actorType: 'user',
    action: 'staff.sessions_revoked',
    entityType: 'user',
    entityId: userId,
  });
  res.json({ status: 'revoked' });
});

async function rescoreApplicantCycles(applicantId: string): Promise<void> {
  const { rows } = await query<{ cycle: string }>(
    `SELECT DISTINCT cycle FROM applications WHERE applicant_id = $1`,
    [applicantId],
  );
  for (const { cycle } of rows) await rescoreCycle(cycle, null);
}
