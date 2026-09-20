/**
 * Time-based one-time passwords (RFC 6238), and the recovery codes that keep
 * them from being a trapdoor.
 *
 * Written against the RFC with node's own crypto rather than pulled in as a
 * dependency: the algorithm is thirty lines, and an auth primitive whose source
 * is in the repository is one whose behaviour can be read at review time.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * -------------------------------
 * The TOTP secret must be stored recoverably — verification needs the same bytes
 * the authenticator app holds, so it cannot be hashed. Recovery codes have no
 * such constraint and are therefore hashed, exactly like a password: the server
 * only ever needs to know whether a code presented matches, never what it was.
 * A leaked database gives up TOTP secrets and nothing about recovery codes.
 *
 * THE REPLAY WINDOW
 * -----------------
 * A code is valid for its 30-second step and one step either side, which absorbs
 * clock drift between a phone and a server. That is also a replay window: the
 * same six digits work for ninety seconds. `lastUsedStep` closes it — a step at
 * or below the last accepted one is refused, so a code observed in transit
 * cannot be used a second time.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 default. Every authenticator app assumes it. */
export const STEP_SECONDS = 30;

/** Steps of drift tolerated either side of now. */
export const DRIFT_STEPS = 1;

const DIGITS = 6;

/** RFC 4648 base32, which is what `otpauth://` URIs carry. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];

  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/** 20 bytes — the SHA-1 block size RFC 4226 recommends for the shared secret. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** One code for one step. SHA-1 is what RFC 6238 specifies and every app expects. */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface VerifyResult {
  ok: boolean;
  /** The step the code belonged to, for storing as `lastUsedStep`. */
  step: number | null;
}

/**
 * Verify a submitted code.
 *
 * `lastUsedStep` is the highest step this account has already spent. Passing it
 * is what makes a code single-use; passing null accepts any step in the window
 * and is only correct during enrolment, where nothing has been spent yet.
 */
export function verifyCode(
  secret: string,
  submitted: string,
  lastUsedStep: number | null,
  at: Date = new Date(),
): VerifyResult {
  const cleaned = submitted.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, step: null };

  const now = currentStep(at);

  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const step = now + offset;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;

    // Both sides are fixed-length ASCII digits, so a constant-time compare is
    // meaningful here rather than theatre.
    const expected = Buffer.from(codeForStep(secret, step));
    const actual = Buffer.from(cleaned);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { ok: true, step };
    }
  }

  return { ok: false, step: null };
}

/**
 * The URI an authenticator app scans.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter —
 * because older apps read only the first and newer ones only the second.
 */
export function otpauthUri(secret: string, email: string, issuer = 'ScholarShield'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* -------------------------------------------------------- recovery codes */

/** How many are issued at enrolment. Shown once, then only their hashes remain. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford-ish base32 without I, L, O, U: the characters people misread when
 * copying a code off a screen, and the one that forms unfortunate words.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode(): string {
  const raw = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += CODE_ALPHABET[raw[i]! % CODE_ALPHABET.length];
  // Grouped for transcription, and normalised away again on the way in.
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}
