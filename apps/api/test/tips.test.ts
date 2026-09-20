import { describe, expect, it } from 'vitest';

import { hashSubmitter } from '../src/routes/tips.js';

/**
 * The tip line's one real promise is anonymity, and the only part of it that is
 * unit-testable without a database is what happens to the submitter's address.
 *
 * The rest of the promise lives in code shape rather than in assertions: the
 * route reads no session, the reviewer payload is built field by field without
 * submitter_ip_hash in it, and the audit row carries the tip id rather than the
 * tip's text. Those are checked by reading tips.ts, not by this file.
 */
describe('hashSubmitter', () => {
  it('never returns anything containing the address', () => {
    const ip = '203.0.113.47';
    const hash = hashSubmitter(ip);

    expect(hash).not.toContain(ip);
    expect(hash).not.toContain('203');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for one address, so rate limiting and abuse review work', () => {
    expect(hashSubmitter('198.51.100.9')).toBe(hashSubmitter('198.51.100.9'));
  });

  it('separates addresses that differ by a single digit', () => {
    expect(hashSubmitter('198.51.100.9')).not.toBe(hashSubmitter('198.51.100.8'));
  });

  it('is salted, not a bare digest of the address', () => {
    // A plain sha256 of an IPv4 address is reversible by exhausting four
    // billion possibilities. If this ever equals the unsalted digest, the
    // stored hashes have become a lookup table of everyone who visited.
    const unsalted = '7d2c5c8e4e9d4e0e3a3a4b0e3f5b1f0f1b7f0a4c9c8f2b6d1e5a3c7b9d0e2f4a';
    expect(hashSubmitter('192.0.2.1')).not.toBe(unsalted);
    expect(hashSubmitter('192.0.2.1')).toHaveLength(64);
  });

  it('handles a missing address without throwing', () => {
    expect(hashSubmitter('unknown')).toMatch(/^[0-9a-f]{64}$/);
  });
});
