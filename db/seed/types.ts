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

export interface SeedApplication {
  /** Stable key within the case, used to assert which applications should flag. */
  ref: string;
  applicantName: string;
  guardianName: string;
  guardianPhone: string;
  addressLine: string;
  district: string;
  pincode: string;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  certificateId: string;
  issuingOffice: string;
  certificateIssueDate: string;
  applicationDate: string;
  cycle: string;
}

export interface SeedCase {
  id: string;
  /** What this case represents, in plain language. */
  behaviour: string;
  applications: SeedApplication[];
}

/** A fraud pattern the rules are explicitly written against. */
export interface KnownCase extends SeedCase {
  /** Rule ids this case is designed to trigger. */
  expectedRules: string[];
  /** Refs a correct system should surface. */
  shouldFlag: string[];
}

/**
 * A legitimate-but-anomalous case: irregular circumstances that are not fraud.
 *
 * These are drawn from documented real-world situations rather than invented, and
 * the list is frozen before rules are tuned. See PROJECT_REPORT.md §6.
 */
export interface EquityCase extends SeedCase {
  /** The real-world circumstance producing the irregularity. */
  circumstance: string;
  /**
   * Rules that may legitimately fire at low or medium severity. A case is only a
   * failure if it produces a HIGH-severity flag — that is the assertion the
   * equity regression suite makes.
   */
  toleratedRules: string[];
}
