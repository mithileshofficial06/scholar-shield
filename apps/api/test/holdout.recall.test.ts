/**
 * HOLDOUT RECALL — reported separately, and never as a pass/fail gate.
 *
 *     npm test -- holdout.recall
 *
 * PROJECT_REPORT.md §13 names this suite alongside `equity.regression`. It
 * existed only inside `npm run metrics` until now, which meant the number was
 * computed when someone remembered to compute it.
 *
 * WHY ALMOST NOTHING HERE IS AN ASSERTION ABOUT RECALL
 * ----------------------------------------------------
 * A test that fails when recall drops is a test that makes recall a target, and
 * a target is exactly what a holdout must never be: the fix for a red build
 * would be to tune against the sealed set, which destroys the only non-circular
 * measurement the project has. Rule 2 of `patterns.holdout.ts` says so directly.
 *
 * So the recall figures are PRINTED, not asserted. What is asserted is the
 * machinery around them — that the corpus is intact, that the retirement
 * bookkeeping is honest, and that the sealed-v2 set has not quietly been
 * targeted. Those can regress silently; recall cannot.
 */

import { describe, expect, it } from 'vitest';

import { RETIRED_CASE_IDS, RETIRED_HOLDOUT_CASES } from '../../../db/seed/holdout-status.js';
import { HOLDOUT_CASES } from '../../../db/seed/patterns.holdout.js';
import { SEALED_V2_CASES } from '../../../db/seed/patterns.sealed-v2.js';
import { CYCLE_DEADLINE } from '../../../db/seed/types.js';
import { evaluateCase, measureRecall } from '../src/evaluation/harness.js';
import { loadRulesConfig } from '../src/household/config.js';

const config = loadRulesConfig();

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

describe('holdout recall (first set — spent)', () => {
  const result = measureRecall(HOLDOUT_CASES as never, config, CYCLE_DEADLINE);

  it('reports the figure without gating on it', () => {
    console.log(
      `  holdout recall ${pct(result.recall)} (${result.caught}/${result.expected})` +
        (result.missed.length ? `\n  missed: ${result.missed.join(', ')}` : ''),
    );
    // The only assertion: the corpus still has something in it. A holdout file
    // emptied by a bad merge would otherwise report a cheerful 100%.
    expect(result.expected).toBeGreaterThan(0);
  });

  it('is fully accounted for: every retired case is a real case', () => {
    const ids = new Set(HOLDOUT_CASES.map((c) => c.id));
    for (const caseId of RETIRED_CASE_IDS) {
      expect(ids.has(caseId), `${caseId} is retired but not in the sealed set`).toBe(true);
    }
  });

  it('records honestly which targeted mechanisms are still missed', () => {
    // holdout-status.ts claims two of the four targeted cases are still not
    // caught. If a later change quietly fixes one, that file is now telling a
    // worse story than the truth, and should be updated rather than left.
    for (const retired of RETIRED_HOLDOUT_CASES) {
      const seedCase = HOLDOUT_CASES.find((c) => c.id === retired.caseId)!;
      const evaluation = evaluateCase(seedCase as never, config, CYCLE_DEADLINE);
      const caught = seedCase.shouldFlag.every((ref) => evaluation.flaggedRefs.has(ref));

      expect(
        caught,
        `holdout-status.ts says ${retired.caseId} is ${retired.caught ? 'caught' : 'still missed'}, ` +
          `but the engine now says ${caught ? 'caught' : 'still missed'}. Update that file.`,
      ).toBe(retired.caught);
    }
  });
});

describe('sealed-v2 recall (pre-registered)', () => {
  const result = measureRecall(SEALED_V2_CASES as never, config, CYCLE_DEADLINE);

  it('reports the figure without gating on it', () => {
    console.log(
      `  sealed-v2 recall ${pct(result.recall)} (${result.caught}/${result.expected}) [pre-registered]`,
    );
    expect(result.expected).toBeGreaterThan(0);
  });

  it('has not been retired into the targeted set', () => {
    // The moment a v5 rule targets one of these, its case id belongs in
    // holdout-status.ts and stops counting. Until then, nothing from this set
    // may appear there — that is what keeps the number pre-registered.
    for (const seedCase of SEALED_V2_CASES) {
      expect(
        RETIRED_CASE_IDS.has(seedCase.id),
        `${seedCase.id} is in holdout-status.ts; it can no longer be quoted as pre-registered`,
      ).toBe(false);
    }
  });

  it('describes mechanisms distinct from the first set', () => {
    // Cheap guard against a future edit copying a first-set case in here, which
    // would make the "clean generalisation" claim false without looking wrong.
    const firstSetIds = new Set(HOLDOUT_CASES.map((c) => c.id));
    for (const seedCase of SEALED_V2_CASES) {
      expect(firstSetIds.has(seedCase.id)).toBe(false);
    }
  });
});
