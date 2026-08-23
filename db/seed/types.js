/**
 * Shared shape for the synthetic corpus.
 *
 * `patterns.holdout.ts` deliberately does NOT import this — it was sealed before
 * this file existed and must stay byte-stable, so it carries its own structurally
 * identical declarations. Do not "tidy" it to use these types; the value of that
 * file is that it has not been touched since it was committed.
 */
/** Annual household income ceiling for scholarship eligibility, in INR. */
export const SCHOLARSHIP_INCOME_CEILING = 250_000;
/** Application deadline for the synthetic admission cycle. */
export const CYCLE_DEADLINE = '2026-07-31';
//# sourceMappingURL=types.js.map