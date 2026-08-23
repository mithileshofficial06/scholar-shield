import { describe, expect, it } from 'vitest';
import {
  componentFor,
  detectComponents,
  edgeKey,
  type HouseholdComponent,
} from '../src/household/components.js';
import type { PairResolution, ResolvedEdge } from '../src/household/resolve.js';

function edge(a: string, b: string, field: ResolvedEdge['matchField'] = 'guardian_name'): ResolvedEdge {
  return { applicationAId: a, applicationBId: b, matchField: field, similarity: 0.9, weight: 0.5 };
}

function pair(a: string, b: string, edges = [edge(a, b)]): PairResolution {
  return { applicationAId: a, applicationBId: b, edges, score: 0.9, linked: true };
}

const keysOf = (components: HouseholdComponent[]) => components.map((c) => c.applicationIds);

describe('detectComponents', () => {
  it('groups a linked pair into one household', () => {
    const components = detectComponents(['a', 'b'], [pair('a', 'b')]);
    expect(keysOf(components)).toEqual([['a', 'b']]);
  });

  it('keeps unlinked applications as households of one', () => {
    // Omitting singletons would make every caller reconstruct them.
    const components = detectComponents(['a', 'b', 'c'], [pair('a', 'b')]);
    expect(keysOf(components)).toEqual([['a', 'b'], ['c']]);
  });

  it('is transitive — A-B and B-C makes one household of three', () => {
    const components = detectComponents(['a', 'b', 'c'], [pair('a', 'b'), pair('b', 'c')]);
    expect(keysOf(components)).toEqual([['a', 'b', 'c']]);
  });

  it('keeps genuinely separate households separate', () => {
    const components = detectComponents(
      ['a', 'b', 'c', 'd'],
      [pair('a', 'b'), pair('c', 'd')],
    );
    expect(keysOf(components)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('ignores pairs that did not link', () => {
    const unlinked: PairResolution = { ...pair('a', 'b'), linked: false, score: 0.2 };
    const components = detectComponents(['a', 'b'], [unlinked]);
    expect(keysOf(components)).toEqual([['a'], ['b']]);
  });

  it('produces a stable key independent of union order', () => {
    const forward = detectComponents(['a', 'b', 'c'], [pair('a', 'b'), pair('b', 'c')]);
    const reversed = detectComponents(['c', 'b', 'a'], [pair('b', 'c'), pair('a', 'b')]);

    expect(forward[0]!.key).toBe(reversed[0]!.key);
    expect(forward[0]!.key).toBe('a');
  });

  it('carries the edges that built each household', () => {
    // The dashboard shows which link produced a household rather than asserting
    // the grouping, so the edges have to survive detection.
    const components = detectComponents(['a', 'b'], [pair('a', 'b')]);
    expect(components[0]!.edges).toHaveLength(1);
    expect(components[0]!.edges[0]!.matchField).toBe('guardian_name');
  });

  it('handles an empty input set', () => {
    expect(detectComponents([], [])).toEqual([]);
  });
});

describe('reviewer edge rejection', () => {
  it('splits a household back apart when its only edge is rejected', () => {
    const linking = edge('a', 'b');
    const rejected = new Set([edgeKey(linking)]);

    const components = detectComponents(['a', 'b'], [pair('a', 'b', [linking])], {
      rejectedEdgeKeys: rejected,
    });

    expect(keysOf(components)).toEqual([['a'], ['b']]);
  });

  it('keeps the household when only one of several edges is rejected', () => {
    const guardian = edge('a', 'b', 'guardian_name');
    const address = edge('a', 'b', 'address');
    const rejected = new Set([edgeKey(guardian)]);

    const components = detectComponents(['a', 'b'], [pair('a', 'b', [guardian, address])], {
      rejectedEdgeKeys: rejected,
    });

    expect(keysOf(components)).toEqual([['a', 'b']]);
    expect(components[0]!.edges.map((e) => e.matchField)).toEqual(['address']);
  });

  it('contains contamination — rejecting the bad seam splits two merged households', () => {
    // The failure mode the rejection mechanism exists for: one spurious link
    // between two real households silently merges both.
    const seam = edge('b', 'c');
    const pairs = [pair('a', 'b'), pair('b', 'c', [seam]), pair('c', 'd')];

    const merged = detectComponents(['a', 'b', 'c', 'd'], pairs);
    expect(keysOf(merged)).toEqual([['a', 'b', 'c', 'd']]);

    const split = detectComponents(['a', 'b', 'c', 'd'], pairs, {
      rejectedEdgeKeys: new Set([edgeKey(seam)]),
    });
    expect(keysOf(split)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('produces a stable edge key regardless of comparison order', () => {
    expect(edgeKey(edge('b', 'a'))).toBe(edgeKey(edge('a', 'b')));
  });
});

describe('componentFor', () => {
  it('finds the household containing an application', () => {
    const components = detectComponents(['a', 'b', 'c'], [pair('a', 'b')]);
    expect(componentFor(components, 'b')!.applicationIds).toEqual(['a', 'b']);
  });

  it('returns null for an unknown application', () => {
    expect(componentFor(detectComponents(['a'], []), 'zzz')).toBeNull();
  });
});
