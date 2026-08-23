/**
 * LEGITIMATE-BUT-ANOMALOUS CASES
 * ==============================
 *
 * Applicants whose circumstances are irregular but not fraudulent. A triage
 * system whose subject is "which economically vulnerable applicants look
 * suspicious" will systematically flag these unless it is built not to
 * (PROJECT_REPORT.md §6).
 *
 * WHAT THE SUITE ASSERTS
 * ----------------------
 * Not "produces no flags" — that would be the wrong bar. A joint family really
 * does put several low-income households at one address, and surfacing that at
 * MEDIUM so a reviewer can clear it in ten seconds is the system working. What
 * must never happen is a HIGH-severity flag, because that is what pushes a
 * legitimate applicant to the top of a queue and frames them as a suspect.
 *
 * So: every case here may fire the rules listed in `toleratedRules`, at low or
 * medium severity. Any high-severity finding is a failure.
 *
 * AUTHORING BASIS AND ITS LIMIT
 * -----------------------------
 * These circumstances are drawn from documented situations — bereavement,
 * relocation, joint-family housing, migrant labour, remarriage, same-cycle
 * sibling filings — rather than invented for convenience, and the list is frozen
 * before rule weights are tuned.
 *
 * Stated plainly: these fixtures and the rules share an author. Passing this
 * suite proves the cases I anticipated are exempted, not that the system is fair.
 * That gap is narrowed by the sourcing above and closed by nothing short of
 * evaluation against real applicants, which this project cannot perform.
 */
import type { EquityCase } from './types.js';
export declare const EQUITY_CASES: EquityCase[];
export declare const EQUITY_APPLICATION_COUNT: number;
