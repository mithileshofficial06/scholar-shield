/**
 * KNOWN-PATTERN RECALL — the internal-consistency baseline.
 *
 *     npm test -- known.recall
 *
 * This measures whether the engine catches the fraud patterns it was explicitly
 * written to catch. A high number here is necessary and close to meaningless on
 * its own: the rules and these fixtures were designed against each other, so
 * anything below ~100% is a bug rather than a finding.
 *
 * The figure that carries information is recall against `patterns.holdout.ts`,
 * sealed before any rule code existed and not opened until Week 5. The GAP
 * between known recall and holdout recall is this project's overfitting measure
 * (PROJECT_REPORT.md §7.1, §8).
 *
 * Reporting known recall by itself — in a README, a demo, or an interview —
 * would be precisely the circular claim the holdout split exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { KNOWN_CASES, KNOWN_EXPECTED_FLAG_COUNT } from '../../../db/seed/patterns.known.js';
import { CYCLE_DEADLINE } from '../../../db/seed/types.js';
import { loadRulesConfig } from '../src/household/config.js';
import { evaluateCase, measureRecall } from '../src/evaluation/harness.js';

const config = loadRulesConfig('v1');

describe('known-pattern recall', () => {
  it('catches every application the known corpus says should surface', () => {
    const result = measureRecall(KNOWN_CASES, config, CYCLE_DEADLINE);

    expect(result.expected).toBe(KNOWN_EXPECTED_FLAG_COUNT);
    expect(result.missed, `missed: ${result.missed.join(', ')}`).toEqual([]);
    expect(result.recall).toBe(1);
  });

  describe.each(KNOWN_CASES.map((c) => [c.id, c] as const))('%s', (_id, seedCase) => {
    it('fires the rules it was designed to trigger', () => {
      const result = evaluateCase(seedCase, config, CYCLE_DEADLINE);
      const missing = seedCase.expectedRules.filter((rule) => !result.firedRules.has(rule));

      expect(missing, `${seedCase.id} did not fire: ${missing.join(', ')}`).toEqual([]);
    });

    it('flags every application listed in shouldFlag', () => {
      const result = evaluateCase(seedCase, config, CYCLE_DEADLINE);
      for (const ref of seedCase.shouldFlag) {
        expect(result.flaggedRefs.has(ref), `${seedCase.id}::${ref} not flagged`).toBe(true);
      }
    });
  });
});

describe('severity is earned, not assumed', () => {
  it('income contradictions reach high severity', () => {
    const result = evaluateCase(KNOWN_CASES[0]!, config, CYCLE_DEADLINE);
    expect(result.highSeverityRefs.size).toBeGreaterThan(0);
  });

  it('an issuing-office mismatch alone does not', () => {
    // A family that moved uses two offices. On its own that is not a suspicion.
    const officeCase = KNOWN_CASES.find((c) => c.id === 'K-04-issuing-office-mismatch')!;
    const result = evaluateCase(officeCase, config, CYCLE_DEADLINE);

    expect(result.firedRules.has('ISSUING_OFFICE_MISMATCH')).toBe(true);
    expect(result.highSeverityRefs.size).toBe(0);
  });

  it('resolution survives a guardian written as an initial', () => {
    // If normalization and resolution fail here, the contradiction is invisible
    // and the case silently passes as clean — the failure mode worth testing.
    const initialCase = KNOWN_CASES.find((c) => c.id === 'K-06-guardian-initial-still-resolves')!;
    const result = evaluateCase(initialCase, config, CYCLE_DEADLINE);

    expect(result.components).toHaveLength(1);
    expect(result.firedRules.has('SIBLING_INCOME_CONTRADICTION')).toBe(true);
  });
});
