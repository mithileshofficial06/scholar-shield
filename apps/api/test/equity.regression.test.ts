/**
 * EQUITY REGRESSION SUITE
 * =======================
 *
 * Run and reported separately from the general rule tests:
 *
 *     npm test -- equity.regression
 *
 * THE ASSERTION
 * -------------
 * Every legitimate-but-anomalous case produces NO high-severity flag.
 *
 * Not "no flags at all" — that would be the wrong bar. A joint family genuinely
 * does put several low-income households at one address, and surfacing that at
 * medium so a reviewer clears it in ten seconds is the system working. What must
 * never happen is a high-severity flag, because that is what lifts a legitimate
 * applicant to the top of the queue and frames them as a suspect.
 *
 * KNOWN LIMIT
 * -----------
 * These fixtures and the rules share an author. Passing proves the anticipated
 * cases are exempted, not that the system is fair. See patterns.equity.ts.
 */

import { describe, expect, it } from 'vitest';
import { EQUITY_CASES } from '../../../db/seed/patterns.equity.js';
import { CYCLE_DEADLINE } from '../../../db/seed/types.js';
import { loadRulesConfig } from '../src/household/config.js';
import { evaluateCase, peakSeverity } from '../src/evaluation/harness.js';

const config = loadRulesConfig('v1');
const evaluate = (c: (typeof EQUITY_CASES)[number]) => evaluateCase(c, config, CYCLE_DEADLINE);

describe('equity regression — legitimate circumstances must not read as fraud', () => {
  it('has fixtures to check', () => {
    expect(EQUITY_CASES.length).toBeGreaterThanOrEqual(7);
  });

  describe.each(EQUITY_CASES.map((c) => [c.id, c] as const))('%s', (_id, seedCase) => {
    it('produces no high-severity flag', () => {
      const result = evaluate(seedCase);

      const highs = result.findings.filter((f) => f.severity === 'high');
      const detail = highs.map((f) => `${f.ruleId}: ${f.reason}`).join('\n');

      expect(
        highs,
        `${seedCase.id} (${seedCase.circumstance}) produced high-severity flags:\n${detail}`,
      ).toEqual([]);
      expect(result.highSeverityRefs.size).toBe(0);
    });

    it('fires only rules the case tolerates', () => {
      const result = evaluate(seedCase);
      const unexpected = [...result.firedRules].filter(
        (rule) => !seedCase.toleratedRules.includes(rule),
      );

      expect(
        unexpected,
        `${seedCase.id} fired rules it does not tolerate: ${unexpected.join(', ')}`,
      ).toEqual([]);
    });
  });
});

describe('specific equity guarantees', () => {
  const byId = (id: string) => EQUITY_CASES.find((c) => c.id === id)!;

  it('E-01: a joint family surfaces at medium, never high', () => {
    const result = evaluate(byId('E-01-joint-family-one-address'));

    expect(result.firedRules.has('ADDRESS_CLUSTER_UNRELATED')).toBe(true);
    expect(peakSeverity(result.findings)).toBe('medium');
  });

  it('E-02: siblings filing in one admission cycle produce nothing at all', () => {
    // Certificates issued days apart is one trip to the taluk office, not
    // certificate shopping.
    const result = evaluate(byId('E-02-siblings-same-admission-cycle'));
    expect(result.findings).toEqual([]);
  });

  it('E-04: a 6% income difference on a low income is not a contradiction', () => {
    const result = evaluate(byId('E-04-minor-income-variation'));
    expect(result.findings).toEqual([]);
  });

  it('E-05: half-siblings in different households are not merged', () => {
    // Merging them would manufacture a contradiction out of two honest filings.
    const result = evaluate(byId('E-05-remarriage-different-guardians'));

    expect(result.components).toHaveLength(2);
    expect(result.findings).toEqual([]);
  });

  it('E-06: a migrant household resolves on guardian and phone despite two addresses', () => {
    const result = evaluate(byId('E-06-migrant-household-split-address'));

    expect(result.components).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('E-07: corroboration adds a signal but never escalates severity', () => {
    // Two low-and-medium signals stay two low-and-medium signals. Corroboration
    // exists to stop a weak rule firing alone, not to promote it.
    const result = evaluate(byId('E-07-tenement-near-deadline'));

    expect(result.firedRules.has('ADDRESS_CLUSTER_UNRELATED')).toBe(true);
    expect(result.firedRules.has('DEADLINE_PROXIMITY')).toBe(true);
    expect(peakSeverity(result.findings)).toBe('medium');
  });
});
