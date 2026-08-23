import { describe, expect, it } from 'vitest';
import { normalizeName } from '../src/household/normalize.js';
import {
  LINK_THRESHOLD,
  linkedPairs,
  nameSimilarity,
  resolvePair,
  trigramSimilarity,
  trigrams,
  type ResolutionInput,
} from '../src/household/resolve.js';

function app(id: string, over: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    id,
    applicantName: 'Karthik Raman',
    guardianName: 'Raman Subramaniam',
    addressLine: '14 Bharathi Street, Ayanavaram',
    district: 'Chennai',
    guardianPhone: '9840112233',
    ...over,
  };
}

describe('trigrams', () => {
  it('pads like pg_trgm — two leading, one trailing, per word', () => {
    expect([...trigrams('abc')]).toEqual(['  a', ' ab', 'abc', 'bc ']);
  });

  it('tokenises on non-alphanumerics', () => {
    expect(trigrams('a-b')).toEqual(trigrams('a b'));
  });

  it('is empty for empty input', () => {
    expect(trigrams('').size).toBe(0);
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(trigramSimilarity('ramanathan', 'ramanathan')).toBe(1);
    expect(trigramSimilarity('ramanathan', 'xyz')).toBe(0);
  });

  it('is symmetric', () => {
    const a = trigramSimilarity('bharati street', 'barati strit');
    const b = trigramSimilarity('barati strit', 'bharati street');
    expect(a).toBe(b);
  });

  it('scores near-misses between 0 and 1', () => {
    const score = trigramSimilarity('govindaraj', 'govindraj');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});

describe('nameSimilarity — token-aligned, minimum across parts', () => {
  const sim = (a: string, b: string) => nameSimilarity(normalizeName(a), normalizeName(b));

  it('scores identical names at 1', () => {
    expect(sim('Raman Subramaniam', 'Raman Subramaniam')).toBe(1);
  });

  it('separates brothers sharing a patronymic', () => {
    // The regression this function exists for. Whole-string trigram scored these
    // 0.65 — enough to link — because `Duraisamy` is longer than either given
    // name and dominates the trigram set. They are two brothers, not one man.
    const score = sim('Shankar Duraisamy', 'Sekar Duraisamy');
    expect(score).toBeLessThan(0.5);
  });

  it('separates cousins sharing a grandfather name', () => {
    expect(sim('Elangovan Duraisamy', 'Sekar Duraisamy')).toBeLessThan(0.5);
    expect(sim('Anand Krishnan', 'Suresh Krishnan')).toBeLessThan(0.5);
  });

  it('still matches transliteration variants of one person', () => {
    // Trigrams do the work *within* a token, so the spelling variance that
    // normalization deliberately leaves behind is still absorbed here.
    expect(sim('Muthusamy Govindaraj', 'Muthuswami Govindraj')).toBeGreaterThan(0.55);
  });

  it('lets an initial stand in for a full token, at reduced weight', () => {
    const withInitial = sim('Muthusamy Govindaraj', 'M. Govindaraj');
    expect(withInitial).toBeGreaterThan(0.55);
    expect(withInitial).toBeLessThan(1);
  });

  it('does not let an initial match a name it does not begin', () => {
    // `M. Kumar` is not `Suresh Kumar`.
    expect(sim('M. Kumar', 'Suresh Kumar')).toBe(0);
  });

  it('ignores extra tokens on the longer name', () => {
    expect(sim('Ganesan Ramalingam Iyer', 'Ganesan Ramalingam')).toBe(1);
  });

  it('returns 0 when either side is initials only', () => {
    // `M. K.` carries no identifying content and must not match the district.
    expect(sim('M. K.', 'Suresh Kumar')).toBe(0);
  });

  it('scores wholly unrelated names at zero', () => {
    expect(sim('Raman Subramaniam', 'Kannan Velusamy')).toBe(0);
  });
});

describe('resolvePair — corroboration is required', () => {
  it('links siblings sharing guardian, address, and phone', () => {
    const result = resolvePair(
      app('a', { applicantName: 'Karthik Raman' }),
      app('b', { applicantName: 'Divya Raman' }),
    );

    expect(result.linked).toBe(true);
    expect(result.edges.map((e) => e.matchField)).toContain('guardian_name');
    expect(result.edges.map((e) => e.matchField)).toContain('address');
  });

  it('does NOT link on a shared guardian name alone', () => {
    // Two families whose fathers happen to share a common name. Linking here
    // would invent a household and flag both as contradicting each other.
    const result = resolvePair(
      app('a', {
        guardianName: 'Ramesh Kumar',
        addressLine: '14 Bharathi Street, Ayanavaram',
        district: 'Chennai',
        guardianPhone: '9840112233',
      }),
      app('b', {
        guardianName: 'Ramesh Kumar',
        addressLine: '90 Salem Road, Sankagiri',
        district: 'Salem',
        guardianPhone: '9500221177',
        applicantName: 'Sathish Kannan',
      }),
    );

    expect(result.linked).toBe(false);
    expect(result.score).toBeLessThan(LINK_THRESHOLD);
  });

  it('does NOT link on a shared address alone', () => {
    // One building, two unrelated families. Common in joint-family housing and
    // exactly the equity case the report names.
    const result = resolvePair(
      app('a', {
        applicantName: 'Bhavani Shankar',
        guardianName: 'Shankar Duraisamy',
        guardianPhone: '9994001122',
      }),
      app('b', {
        applicantName: 'Manoj Sekar',
        guardianName: 'Sekar Ponnusamy',
        guardianPhone: '9080117733',
      }),
    );

    expect(result.linked).toBe(false);
  });

  it('does NOT link on a shared phone alone', () => {
    // A shared number can be a facilitator filing for several families.
    const result = resolvePair(
      app('a', {
        applicantName: 'Bhavani Shankar',
        guardianName: 'Shankar Duraisamy',
        addressLine: '2 Gandhi Nagar',
        district: 'Erode',
        guardianPhone: '9994001122',
      }),
      app('b', {
        applicantName: 'Sathish Kannan',
        guardianName: 'Kannan Velusamy',
        addressLine: '90 Salem Road, Sankagiri',
        district: 'Salem',
        guardianPhone: '9994001122',
      }),
    );

    expect(result.linked).toBe(false);
    expect(result.edges.map((e) => e.matchField)).toEqual(['phone']);
  });

  it('links guardian + phone across a change of address', () => {
    const result = resolvePair(
      app('a', { addressLine: '14 Bharathi Street, Ayanavaram', district: 'Chennai' }),
      app('b', {
        applicantName: 'Divya Raman',
        addressLine: '7/2 Kamaraj Nagar, Villivakkam',
        district: 'Chennai',
      }),
    );

    expect(result.linked).toBe(true);
  });

  it('resolves a guardian written as an initial', () => {
    const result = resolvePair(
      app('a', { guardianName: 'Muthusamy Govindaraj' }),
      app('b', { guardianName: 'M. Govindaraj', applicantName: 'Gowri Muthusamy' }),
    );

    const guardianEdge = result.edges.find((e) => e.matchField === 'guardian_name');
    expect(guardianEdge).toBeDefined();
    expect(result.linked).toBe(true);
  });

  it('emits no edges for wholly unrelated applications', () => {
    const result = resolvePair(
      app('a'),
      app('b', {
        applicantName: 'Yamini Chidambaram',
        guardianName: 'Chidambaram Natesan',
        addressLine: '5 Polur Road',
        district: 'Tiruvannamalai',
        guardianPhone: '9962118833',
      }),
    );

    expect(result.edges).toEqual([]);
    expect(result.linked).toBe(false);
  });

  it('records similarity and weight on every edge for the reviewer drill-down', () => {
    const result = resolvePair(app('a'), app('b', { applicantName: 'Divya Raman' }));

    for (const edge of result.edges) {
      expect(edge.similarity).toBeGreaterThan(0);
      expect(edge.similarity).toBeLessThanOrEqual(1);
      expect(edge.weight).toBeGreaterThan(0);
    }
  });
});

describe('linkedPairs', () => {
  it('returns only pairs over the link threshold', () => {
    const inputs = [
      app('a', { applicantName: 'Karthik Raman' }),
      app('b', { applicantName: 'Divya Raman' }),
      app('c', {
        applicantName: 'Yamini Chidambaram',
        guardianName: 'Chidambaram Natesan',
        addressLine: '5 Polur Road',
        district: 'Tiruvannamalai',
        guardianPhone: '9962118833',
      }),
    ];

    const pairs = linkedPairs(inputs);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.applicationAId, pairs[0]!.applicationBId].sort()).toEqual(['a', 'b']);
  });

  it('is order-independent', () => {
    const inputs = [app('a'), app('b', { applicantName: 'Divya Raman' })];
    const forward = linkedPairs(inputs).length;
    const reversed = linkedPairs([...inputs].reverse()).length;
    expect(forward).toBe(reversed);
  });
});
