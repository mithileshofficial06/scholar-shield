import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@scholarshield/shared';
import { query } from '../db.js';
import { verifySession, type SessionClaims } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionClaims;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.get('cookie');
  const match = cookie?.match(/(?:^|;\s*)ss_session=([^;]+)/);
  return match?.[1] ?? null;
}

/** Attaches a session if one is present. Does not reject. */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const claims = verifySession(token);
    if (claims) req.session = claims;
  }
  next();
}

/**
 * Whether a staff token is still honoured: the account exists, is active, and
 * has not had its sessions revoked since this token was issued.
 *
 * A signature check alone cannot answer this — a JWT stays valid until it
 * expires whatever happens to the account behind it — so it costs one indexed
 * lookup per staff request. Staff traffic is a committee, not the public.
 */
export async function staffSessionIsLive(sub: string, sv: number | undefined): Promise<UserRole | null> {
  const { rows } = await query<{ role: UserRole; session_version: number }>(
    `SELECT role, session_version FROM users
      WHERE id = $1 AND activated_at IS NOT NULL AND deactivated_at IS NULL`,
    [sub],
  );
  const user = rows[0];
  if (!user || user.session_version !== (sv ?? 0)) return null;
  return user.role;
}

/** Staff only. Optionally narrowed to specific roles. */
export function requireStaff(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.session;
    if (!session || session.kind !== 'staff') {
      res.status(401).json({ error: 'unauthorized', message: 'Staff session required.' });
      return;
    }

    // The role is read from the database, not the token: a demotion takes
    // effect on the next request rather than when the token expires.
    const role = await staffSessionIsLive(session.sub, session.sv);
    if (!role) {
      res.status(401).json({ error: 'session_revoked', message: 'This session is no longer valid. Sign in again.' });
      return;
    }
    session.role = role;

    if (roles.length > 0 && !roles.includes(role)) {
      res.status(403).json({ error: 'forbidden', message: 'Insufficient role.' });
      return;
    }
    next();
  };
}

/** Applicant only. Route handlers must still scope every query to session.sub. */
export function requireApplicant(req: Request, res: Response, next: NextFunction): void {
  const session = req.session;
  if (!session || session.kind !== 'applicant') {
    res.status(401).json({ error: 'unauthorized', message: 'Applicant session required.' });
    return;
  }
  next();
}
