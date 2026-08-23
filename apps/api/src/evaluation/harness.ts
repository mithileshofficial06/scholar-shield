/**
 * Runs the whole Tier 1 engine over a set of synthetic applications, in memory.
 *
 * normalize -> resolve -> components -> contradiction rules -> findings.
 *
 * This is the single entry point used by the equity regression suite, the
 * known-pattern recall suite, and (in Week 5) the holdout recall and metrics
 * script. Sharing one path matters: if each suite wired the stages together
 * itself, they could drift, and a metric would then describe a pipeline that
 * does not exist anywhere.
 *
 * Deliberately database-free. The DB path uses pg_trgm to narrow candidates
 * before scoring, but the scoring is identical, so results here are the same
 * results production reaches.
 */

import { detectComponents, type HouseholdComponent } from '../household/components.js';
import { normalizeIdentity } from '../household/normalize.js';
import { resolveAll, type ResolutionInput } from '../household/resolve.js';
import {
  evaluateRules,
  type RuleFinding,
  type RulesConfig,
  type ScorableApplication,
  type Severity,
} from '../household/rules.js';

/** The subset of a seed application the engine reads. */
export interface HarnessApplication {
  ref: string;
  applicantName: string;
  guardianName: string;
  guardianPhone: string;
  addressLine: string;
  district: string;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  issuingOffice: string;
  certificateIssueDate: string;
  cycle: string;
}

export interface HarnessCase {
  id: string;
  applications: HarnessApplication[];
}

export interface CaseEvaluation {
  caseId: string;
  findings: RuleFinding[];
  scores: Map<string, number>;
  components: HouseholdComponent[];
  /** Refs that received at least one finding. */
  flaggedRefs: Set<string>;
  /** Refs that received a high-severity finding. */
  highSeverityRefs: Set<string>;
  /** Distinct rule ids that fired anywhere in the case. */
  firedRules: Set<string>;
}

/**
 * Application ids are namespaced per case (`${caseId}::${ref}`) so several cases
 * can be evaluated in one corpus without a shared address or guardian name in
 * one case silently linking into another.
 */
function idFor(caseId: string, ref: string): string {
  return `${caseId}::${ref}`;
}

function toResolutionInput(caseId: string, app: HarnessApplication): ResolutionInput {
  return {
    id: idFor(caseId, app.ref),
    applicantName: app.applicantName,
    guardianName: app.guardianName,
    addressLine: app.addressLine,
    district: app.district,
    guardianPhone: app.guardianPhone,
  };
}

function toScorable(caseId: string, app: HarnessApplication): ScorableApplication {
  const identity = normalizeIdentity({
    applicantName: app.applicantName,
    guardianName: app.guardianName,
    addressLine: app.addressLine,
    district: app.district,
    guardianPhone: app.guardianPhone,
  });

  return {
    id: idFor(caseId, app.ref),
    cycle: app.cycle,
    applicantName: app.applicantName,
    declaredAnnualIncome: app.declaredAnnualIncome,
    declaredFamilySize: app.declaredFamilySize,
    normalizedGuardianName: identity.normalizedGuardianName,
    normalizedAddress: identity.normalizedAddress,
    issuingOffice: app.issuingOffice,
    certificateIssueDate: app.certificateIssueDate,
  };
}

/** Run the engine over one case in isolation. */
export function evaluateCase(
  seedCase: HarnessCase,
  config: RulesConfig,
  cycleDeadline: string,
): CaseEvaluation {
  const resolutionInputs = seedCase.applications.map((a) => toResolutionInput(seedCase.id, a));
  const scorables = seedCase.applications.map((a) => toScorable(seedCase.id, a));

  const pairs = resolveAll(resolutionInputs);
  const components = detectComponents(
    scorables.map((a) => a.id),
    pairs,
  );

  const { findings, scores } = evaluateRules(scorables, components, config, cycleDeadline);

  const stripId = (id: string) => id.slice(seedCase.id.length + 2);

  const flaggedRefs = new Set(findings.map((f) => stripId(f.applicationId)));
  const highSeverityRefs = new Set(
    findings.filter((f) => f.severity === 'high').map((f) => stripId(f.applicationId)),
  );

  return {
    caseId: seedCase.id,
    findings,
    scores,
    components,
    flaggedRefs,
    highSeverityRefs,
    firedRules: new Set(findings.map((f) => f.ruleId)),
  };
}

/** Highest severity present in a set of findings, or null when there are none. */
export function peakSeverity(findings: readonly RuleFinding[]): Severity | null {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  if (findings.some((f) => f.severity === 'low')) return 'low';
  return null;
}

export interface RecallResult {
  expected: number;
  caught: number;
  missed: string[];
  recall: number;
}

/**
 * Recall over a set of cases: of the applications a corpus says should surface,
 * how many did the engine actually flag.
 */
export function measureRecall(
  cases: readonly (HarnessCase & { shouldFlag: string[] })[],
  config: RulesConfig,
  cycleDeadline: string,
): RecallResult {
  let expected = 0;
  let caught = 0;
  const missed: string[] = [];

  for (const seedCase of cases) {
    const result = evaluateCase(seedCase, config, cycleDeadline);
    for (const ref of seedCase.shouldFlag) {
      expected += 1;
      if (result.flaggedRefs.has(ref)) caught += 1;
      else missed.push(`${seedCase.id}::${ref}`);
    }
  }

  return {
    expected,
    caught,
    missed,
    recall: expected === 0 ? 0 : caught / expected,
  };
}
