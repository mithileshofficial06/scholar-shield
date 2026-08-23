import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@scholarshield/shared';
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

/** Staff only. Optionally narrowed to specific roles. */
export function requireStaff(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = req.session;
    if (!session || session.kind !== 'staff') {
      res.status(401).json({ error: 'unauthorized', message: 'Staff session required.' });
      return;
    }
    if (roles.length > 0 && !roles.includes(session.role)) {
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
