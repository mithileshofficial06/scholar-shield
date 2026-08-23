/**
 * KNOWN FRAUD PATTERNS
 * ====================
 *
 * The fraud patterns the Tier 1 rules are explicitly written against. Recall
 * measured here is an internal-consistency baseline — it demonstrates the engine
 * catches what it was designed to catch, and nothing more than that.
 *
 * The number that actually means something is recall against
 * `patterns.holdout.ts`, which was sealed before any rule code existed. The gap
 * between the two figures is this project's overfitting measure
 * (PROJECT_REPORT.md §7.1, §8).
 *
 * Quoting known recall on its own, in a demo or anywhere else, would be the exact
 * circular claim the holdout split exists to prevent.
 */
import type { KnownCase } from './types.js';
export declare const KNOWN_CASES: KnownCase[];
export declare const KNOWN_APPLICATION_COUNT: number;
export declare const KNOWN_EXPECTED_FLAG_COUNT: number;
