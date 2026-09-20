/**
 * TOTP, checked against RFC 6238's own published vectors.
 *
 * An auth primitive implemented in-repo has to prove it is the standard and not
 * merely self-consistent: a wrong-but-deterministic implementation passes every
 * round-trip test anyone writes for it and then fails against a real phone. The
 * vectors below come from RFC 6238 Appendix B and are the whole reason to trust
 * this file.
 */

import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  codeForStep,
  currentStep,
  DRIFT_STEPS,
  generateRecoveryCode,
  generateSecret,
  normalizeRecoveryCode,
  otpauthUri,
  STEP_SECONDS,
  verifyCode,
} from '../src/auth/totp.js';

/** RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA-1. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const input = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0x55, 0xaa]);
    expect(base32Decode(base32Encode(input)).equals(input)).toBe(true);
  });

  it('matches the known encoding of the RFC seed', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('ignores padding and whitespace on the way in', () => {
    const plain = base32Decode('GEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZD GNBV GY3T QOJQ==').equals(plain)).toBe(true);
  });

  it('rejects characters that are not base32', () => {
    expect(() => base32Decode('GEZD!NBV')).toThrow();
  });
});

describe('codeForStep — RFC 6238 Appendix B vectors', () => {
  // Each row: unix time from the RFC, and the SHA-1 code it publishes. The RFC
  // prints eight digits; a six-digit implementation takes the last six.
  const vectors: [number, string][] = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ];

  for (const [unixTime, expected] of vectors) {
    it(`matches the published code at t=${unixTime}`, () => {
      const step = Math.floor(unixTime / STEP_SECONDS);
      expect(codeForStep(RFC_SECRET, step)).toBe(expected);
    });
  }
});

describe('verifyCode', () => {
  const at = new Date('2026-09-20T09:00:00Z');
  const step = currentStep(at);

  it('accepts the current code', () => {
    const code = codeForStep(RFC_SECRET, step);
    expect(verifyCode(RFC_SECRET, code, null, at)).toEqual({ ok: true, step });
  });

  it('tolerates a phone one step out either way', () => {
    for (const offset of [-DRIFT_STEPS, DRIFT_STEPS]) {
      const code = codeForStep(RFC_SECRET, step + offset);
      expect(verifyCode(RFC_SECRET, code, null, at).ok).toBe(true);
    }
  });

  it('refuses a code from outside the drift window', () => {
    const stale = codeForStep(RFC_SECRET, step - (DRIFT_STEPS + 1));
    expect(verifyCode(RFC_SECRET, stale, null, at).ok).toBe(false);
  });

  it('refuses a code already spent, so it cannot be replayed', () => {
    // THE reason lastUsedStep exists. A code stays valid for 90 seconds across
    // the drift window; without this, a code seen in transit works again.
    const code = codeForStep(RFC_SECRET, step);
    const first = verifyCode(RFC_SECRET, code, null, at);
    expect(first.ok).toBe(true);

    expect(verifyCode(RFC_SECRET, code, first.step, at).ok).toBe(false);
  });

  it('still accepts the NEXT code after one is spent', () => {
    const spent = currentStep(at);
    const next = codeForStep(RFC_SECRET, spent + 1);
    expect(verifyCode(RFC_SECRET, next, spent, at).ok).toBe(true);
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyCode(RFC_SECRET, bad, null, at).ok).toBe(false);
    }
  });

  it('accepts a code typed with spaces, as apps display it', () => {
    const code = codeForStep(RFC_SECRET, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyCode(RFC_SECRET, spaced, null, at).ok).toBe(true);
  });

  it('refuses a valid code for a different secret', () => {
    const other = generateSecret();
    const code = codeForStep(other, step);
    expect(verifyCode(RFC_SECRET, code, null, at).ok).toBe(false);
  });
});

describe('generateSecret', () => {
  it('produces a 20-byte secret, the size RFC 4226 recommends', () => {
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, generateSecret));
    expect(seen.size).toBe(50);
  });
});

describe('otpauthUri', () => {
  it('carries the issuer in both places apps read it from', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'reviewer@scholarshield.local');
    expect(uri.startsWith('otpauth://totp/ScholarShield%3Areviewer%40scholarshield.local?')).toBe(
      true,
    );
    expect(uri).toContain('issuer=ScholarShield');
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});

describe('recovery codes', () => {
  it('avoids the characters people misread off a screen', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateRecoveryCode()).not.toMatch(/[ILOU]/);
    }
  });

  it('is grouped for transcription and normalises back', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(normalizeRecoveryCode(code)).toHaveLength(10);
  });

  it('normalises case and punctuation, so a retyped code still matches', () => {
    expect(normalizeRecoveryCode('a1b2c-3d4e5')).toBe(normalizeRecoveryCode('A1B2C3D4E5'));
    expect(normalizeRecoveryCode(' a1b2c 3d4e5 ')).toBe(normalizeRecoveryCode('A1B2C-3D4E5'));
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(seen.size).toBe(200);
  });
});
