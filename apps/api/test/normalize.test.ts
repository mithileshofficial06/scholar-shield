import { describe, expect, it } from 'vitest';
import {
  normalizeAddress,
  normalizeIdentity,
  normalizeName,
  normalizePhone,
} from '../src/household/normalize.js';

describe('normalizeName', () => {
  it('strips honorifics, punctuation, and casing', () => {
    expect(normalizeName('Thiru. Raman Subramaniam').canonical).toBe(
      normalizeName('raman subramaniam').canonical,
    );
    expect(normalizeName('Smt Lakshmi Narayanan').tokens).not.toContain('smt');
  });

  it('separates initials from full name tokens', () => {
    const parsed = normalizeName('M. Govindaraj');
    expect(parsed.initials).toEqual(['m']);
    expect(parsed.tokens).toEqual(['govindaraj']);
  });

  it('collapses common transliteration alternates', () => {
    // th/t and doubled letters are orthographic, not distinguishing.
    expect(normalizeName('Muthusamy').canonical).toBe(normalizeName('Mutusami').canonical);
    expect(normalizeName('Krishnan').canonical).toBe(normalizeName('Krishnann').canonical);
    expect(normalizeName('Lakshmi').canonical).toBe(normalizeName('Lakshmee').canonical);
  });

  it('does NOT force genuinely different names together', () => {
    // The conservatism the module is built around: a false merge invents a
    // household and flags two unrelated families.
    expect(normalizeName('Ramesh').canonical).not.toBe(normalizeName('Rajesh').canonical);
    expect(normalizeName('Selvaraj').canonical).not.toBe(normalizeName('Selvakumar').canonical);
    expect(normalizeName('Anand Krishnan').canonical).not.toBe(
      normalizeName('Anand Kannan').canonical,
    );
  });

  it('handles empty and junk input without throwing', () => {
    expect(normalizeName('').canonical).toBe('');
    expect(normalizeName(null).tokens).toEqual([]);
    expect(normalizeName('   ...   ').canonical).toBe('');
  });
});

describe('normalizeAddress', () => {
  it('expands abbreviations', () => {
    expect(normalizeAddress('14 Bharathi St')).toBe(normalizeAddress('14 Bharathi Street'));
    expect(normalizeAddress('7 Gandhi Rd')).toBe(normalizeAddress('7 Gandhi Road'));
  });

  it('normalises ordinals and door-number noise', () => {
    expect(normalizeAddress('4 Thillai Nagar 2nd Cross')).toBe(
      normalizeAddress('No. 4, Thillai Nagar, 2 Cross'),
    );
  });

  it('keeps distinct addresses distinct', () => {
    expect(normalizeAddress('14 Bharathi Street')).not.toBe(normalizeAddress('41 Bharathi Street'));
    expect(normalizeAddress('14 Bharathi Street')).not.toBe(normalizeAddress('14 Kamaraj Street'));
  });

  it('preserves house numbers rather than transliterating them', () => {
    expect(normalizeAddress('108 Trichy Main Road')).toContain('108');
  });
});

describe('normalizePhone', () => {
  it('reduces Indian mobile formats to ten significant digits', () => {
    expect(normalizePhone('+91 98401 12233')).toBe('9840112233');
    expect(normalizePhone('098401-12233')).toBe('9840112233');
    expect(normalizePhone('9840112233')).toBe('9840112233');
  });

  it('rejects input that would create edges on junk', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('0000000000')).toBeNull(); // not a valid mobile prefix
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('normalizeIdentity', () => {
  it('folds district into the address so identical streets in different districts differ', () => {
    const a = normalizeIdentity({
      applicantName: 'Bhavani Shankar',
      guardianName: 'Shankar Duraisamy',
      addressLine: '2 Gandhi Nagar',
      district: 'Erode',
    });
    const b = normalizeIdentity({
      applicantName: 'Bhavani Shankar',
      guardianName: 'Shankar Duraisamy',
      addressLine: '2 Gandhi Nagar',
      district: 'Salem',
    });

    expect(a.normalizedAddress).not.toBe(b.normalizedAddress);
  });

  it('produces every field the resolver reads', () => {
    const result = normalizeIdentity({
      applicantName: 'Karthik Raman',
      guardianName: 'Thiru. Raman Subramaniam',
      addressLine: '14 Bharathi St, Ayanavaram',
      district: 'Chennai',
      guardianPhone: '+91 98401 12233',
    });

    expect(result.normalizedApplicantName).toBeTruthy();
    expect(result.normalizedGuardianName).toBeTruthy();
    expect(result.normalizedPhone).toBe('9840112233');

    // `St` expands to `street`, which then transliterates like any other word.
    // What matters is that the abbreviated and written-out forms agree, not that
    // the canonical form is spelled the way a human would write it.
    expect(result.normalizedAddress).toBe(
      normalizeAddress('14 Bharathi Street, Ayanavaram Chennai'),
    );
  });
});
