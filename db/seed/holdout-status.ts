/**
 * WHICH SEALED HOLDOUT CASES THE ENGINE NOW EXPLICITLY TARGETS
 * ============================================================
 *
 * `patterns.holdout.ts` is never edited. Its evidentiary value is that it has
 * not been touched since it was committed, and `git log --diff-filter=A` on it
 * against `rules.ts` is the whole proof. Rule 3 in that file says a pattern the
 * engine comes to target must leave the holdout count; this file is how that
 * happens without altering a single byte of the sealed set.
 *
 * WHAT HAPPENED, PLAINLY
 * ----------------------
 * The v3 metrics run published holdout recall of 38.2% and, in the generated
 * note, named the rule families that were missing — "income bunching below the
 * ceiling, certificate serial adjacency, ... deliberate household splitting".
 * The v4 rules were then written against those mechanisms.
 *
 * The sealed CASE DATA was not opened to write them, and no threshold in
 * `rules.ts` was chosen by checking what a holdout case needed. But the
 * published miss analysis named the families, so the choice of what to build was
 * informed by the holdout's own results. That is leakage. It is mild, it is the
 * ordinary way a project learns from an evaluation, and it still means the
 * post-v4 figure is not the clean generalisation number the pre-v4 one was.
 *
 * WHY THIS KILLS THE HOLDOUT RATHER THAN SHRINKING IT
 * ---------------------------------------------------
 * The tempting move is to report recall over the un-retired cases and call that
 * the honest number. It is not, and the arithmetic shows why: the retired set
 * below is *exactly* the set of cases v3 missed, so the remainder is exactly the
 * set v3 caught, and recall over it is 100% by construction. A number that
 * cannot come out any other way measures nothing.
 *
 * So the sealed holdout is spent, completely, and no slice of it can be quoted
 * as evidence of generalisation again. The aggregate figure stays in the README
 * because deleting a number that got worse-founded would be its own dishonesty —
 * but it is reported as what it now is.
 *
 * The next honest number needs a new set, authored against mechanisms nobody has
 * written rules for, sealed before those rules exist. `patterns.sealed-v2.ts` is
 * that set. It carries a weaker claim than this one did and says so in its own
 * header.
 */

export interface RetiredHoldoutCase {
  caseId: string;
  /** The rule now written against this mechanism. */
  targetedBy: string;
  /** The rule-config version that introduced it. */
  since: string;
  /** Whether that rule actually catches the case. Being targeted is not catching. */
  caught: boolean;
  note: string;
}

/**
 * Note the two `caught: false` rows. A rule was written for each of those
 * mechanisms and still does not surface the case — which is worth more, printed
 * plainly, than a tidier table would be. Both are analysed in the README.
 */
export const RETIRED_HOLDOUT_CASES: RetiredHoldoutCase[] = [
  {
    caseId: 'HO-02-threshold-bunching',
    targetedBy: 'INCOME_THRESHOLD_BUNCHING',
    since: 'v4',
    caught: true,
    note: 'Threshold gaming. The rule compares the density of the band below the ceiling against the band below that, so it fires on the comparison rather than on any applicant being near the line.',
  },
  {
    caseId: 'HO-04-certificate-serial-adjacency',
    targetedBy: 'CERTIFICATE_SERIAL_ADJACENCY',
    since: 'v4',
    caught: true,
    note: 'Bulk issuance. Same office, same serial series, tight numeric run, unrelated households.',
  },
  {
    caseId: 'HO-09-identical-round-income-mill',
    targetedBy: 'IDENTICAL_ROUND_INCOME_CLUSTER',
    since: 'v4',
    caught: false,
    note: 'Targeted but still missed. The rule requires the repeated round figure to come from ONE issuing office, which is the condition carrying its precision — dropping it would flag every district where many families honestly declare the same round number. A cross-office variant is a v5 candidate and must be validated against patterns.sealed-v2.ts, not against this case, which is now known.',
  },
  {
    caseId: 'HO-10-deliberate-household-split',
    targetedBy: 'HOUSEHOLD_FRAGMENTATION',
    since: 'v4',
    caught: false,
    note: 'Targeted but still missed. The rule fires on pairs scoring between 0.38 and the 0.55 link threshold on two or more independent fields; this split evidently clears neither condition. Loosening either from here would be tuning against a case whose answer is known.',
  },
];

export const RETIRED_CASE_IDS: ReadonlySet<string> = new Set(
  RETIRED_HOLDOUT_CASES.map((c) => c.caseId),
);
