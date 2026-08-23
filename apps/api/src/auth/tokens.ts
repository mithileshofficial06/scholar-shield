import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { UserRole } from '@scholarshield/shared';

/**
 * Two distinct principals, deliberately not interchangeable:
 *
 *   staff     — reviewers and admins. Can see scores, flags, households.
 *   applicant — scoped to a single application id. Can never see any of that.
 *
 * The `sub` of an applicant token is the applicant, and `applicationId` narrows it
 * further, so a leaked token cannot be walked sideways to another application.
 */
export interface StaffClaims {
  kind: 'staff';
  sub: string;
  role: UserRole;
}

export interface ApplicantClaims {
  kind: 'applicant';
  sub: string;
  applicationId: string | null;
}

export type SessionClaims = StaffClaims | ApplicantClaims;

export function issueSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.JWT_SECRET, {
    expiresIn: `${config.SESSION_TTL_HOURS}h`,
    issuer: 'scholarshield',
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'scholarshield',
    });
    if (typeof decoded === 'string') return null;
    const kind = (decoded as Record<string, unknown>).kind;
    if (kind !== 'staff' && kind !== 'applicant') return null;
    return decoded as unknown as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Magic-link tokens are returned once to the caller and stored only as a hash,
 * so a database read cannot mint a working login link.
 */
export function createMagicLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function magicLinkExpiry(): Date {
  return new Date(Date.now() + config.MAGIC_LINK_TTL_MINUTES * 60_000);
}
