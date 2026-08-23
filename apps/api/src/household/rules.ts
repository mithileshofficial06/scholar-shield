/**
 * Contradiction rules — step 4 of the household reconciliation engine
 * (PROJECT_REPORT.md §5 Tier 1).
 *
 * Every rule returns a finding carrying a human-readable reason, the rule id, the
 * config version, and the exact values that triggered it. A reviewer sees why,
 * not a number — which is what makes a flagged-but-legitimate case fast to clear
 * rather than defaulting to suspicion.
 *
 * Nothing here decides an outcome. Findings become `risk_flags` rows, and flags
 * change queue position only.
 */

import type { HouseholdComponent } from './components.js';

export type Severity = 'low' | 'medium' | 'high';

export interface RuleConfig {
  enabled: boolean;
  severity: Severity;
  weight: number;
  incomeTolerancePercent?: number;
  incomeToleranceAbsolute?: number;
  minDistinctHouseholds?: number;
  windowDays?: number;
  requiresCorroboration?: boolean;
}

export interface RulesConfig {
  version: string;
  scholarshipIncomeCeiling: number;
  highSeverityScoreThreshold: number;
  rules: Record<string, RuleConfig>;
}

export interface ScorableApplication {
  id: string;
  cycle: string;
  applicantName: string;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  normalizedGuardianName: string;
  normalizedAddress: string;
  issuingOffice: string | null;
  /** ISO date, or null when OCR could not read one. */
  certificateIssueDate: string | null;
}

export interface RuleFinding {
  applicationId: string;
  ruleId: string;
  severity: Severity;
  weight: number;
  reason: string;
  evidence: Record<string, unknown>;
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function money(value: number): string {
  return inr.format(value);
}

/**
 * Both tolerances must be exceeded before an income gap counts as a contradiction.
 *
 * A percentage alone fires on small absolute gaps between low incomes — a ₹4,000
 * difference on ₹24,000 is 17%, and it is also the kind of variation two
 * certificates issued months apart genuinely show. Flagging that targets exactly
 * the applicants least able to contest it.
 */
function exceedsTolerance(a: number, b: number, config: RuleConfig): boolean {
  const gap = Math.abs(a - b);
  const base = Math.max(a, b);
  if (base === 0) return false;

  const percent = (gap / base) * 100;
  return (
    percent > (config.incomeTolerancePercent ?? 15) &&
    gap > (config.incomeToleranceAbsolute ?? 12_000)
  );
}

function describeGap(a: number, b: number): string {
  const gap = Math.abs(a - b);
  const percent = Math.round((gap / Math.max(a, b)) * 100);
  return `${money(gap)} (${percent}%)`;
}

// ---------------------------------------------------------------- rules

/** Two applications in one household declaring materially different incomes. */
export function siblingIncomeContradiction(
  component: HouseholdComponent,
  byId: ReadonlyMap<string, ScorableApplication>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled || component.applicationIds.length < 2) return [];

  const members = component.applicationIds
    .map((id) => byId.get(id))
    .filter((a): a is ScorableApplication => a !== undefined);

  const findings: RuleFinding[] = [];
  const flagged = new Set<string>();

  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      if (!exceedsTolerance(a.declaredAnnualIncome, b.declaredAnnualIncome, config)) continue;

      // Both sides of the contradiction are flagged — neither application is
      // presumptively the honest one, and the reviewer decides.
      for (const [self, other] of [
        [a, b],
        [b, a],
      ] as const) {
        if (flagged.has(self.id)) continue;
        flagged.add(self.id);

        findings.push({
          applicationId: self.id,
          ruleId: 'SIBLING_INCOME_CONTRADICTION',
          severity: config.severity,
          weight: config.weight,
          reason:
            `This application declares a household income of ${money(self.declaredAnnualIncome)}, ` +
            `while ${other.applicantName} — resolved to the same household — declares ` +
            `${money(other.declaredAnnualIncome)}. The two differ by ${describeGap(a.declaredAnnualIncome, b.declaredAnnualIncome)}. ` +
            `Certificates describing one household would normally agree.`,
          evidence: {
            householdKey: component.key,
            thisIncome: self.declaredAnnualIncome,
            otherApplicationId: other.id,
            otherApplicantName: other.applicantName,
            otherIncome: other.declaredAnnualIncome,
            differenceAbsolute: Math.abs(a.declaredAnnualIncome - b.declaredAnnualIncome),
          },
        });
      }
    }
  }

  return findings;
}

/**
 * The same guardian appearing with materially different incomes in *different*
 * households. Catches the case where resolution failed to merge but the guardian
 * name is identical. Same-household pairs are skipped — sibling contradiction
 * already covers those, and double-counting one fact inflates the score.
 */
export function guardianIncomeContradiction(
  applications: readonly ScorableApplication[],
  householdOf: ReadonlyMap<string, string>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const byGuardian = new Map<string, ScorableApplication[]>();
  for (const app of applications) {
    if (!app.normalizedGuardianName) continue;
    const bucket = byGuardian.get(app.normalizedGuardianName) ?? [];
    bucket.push(app);
    byGuardian.set(app.normalizedGuardianName, bucket);
  }

  const findings: RuleFinding[] = [];
  const flagged = new Set<string>();

  for (const [guardian, group] of byGuardian) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;

        if (householdOf.get(a.id) === householdOf.get(b.id)) continue;
        if (!exceedsTolerance(a.declaredAnnualIncome, b.declaredAnnualIncome, config)) continue;

        for (const [self, other] of [
          [a, b],
          [b, a],
        ] as const) {
          if (flagged.has(self.id)) continue;
          flagged.add(self.id);

          findings.push({
            applicationId: self.id,
            ruleId: 'GUARDIAN_INCOME_CONTRADICTION',
            severity: config.severity,
            weight: config.weight,
            reason:
              `The guardian named here also appears on ${other.applicantName}'s application, ` +
              `filed as a separate household, declaring ${money(other.declaredAnnualIncome)} ` +
              `against this application's ${money(self.declaredAnnualIncome)} — a difference of ` +
              `${describeGap(a.declaredAnnualIncome, b.declaredAnnualIncome)}.`,
            evidence: {
              normalizedGuardianName: guardian,
              thisIncome: self.declaredAnnualIncome,
              otherApplicationId: other.id,
              otherApplicantName: other.applicantName,
              otherIncome: other.declaredAnnualIncome,
            },
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Several separately-resolved households at one address, all declaring incomes
 * below the eligibility ceiling.
 *
 * Medium severity deliberately. Joint families, tenements, and migrant-labour
 * housing put many genuinely low-income families at one address.
 */
export function addressClusterUnrelated(
  applications: readonly ScorableApplication[],
  householdOf: ReadonlyMap<string, string>,
  config: RuleConfig,
  ceiling: number,
): RuleFinding[] {
  if (!config.enabled) return [];

  const minHouseholds = config.minDistinctHouseholds ?? 3;
  const byAddress = new Map<string, ScorableApplication[]>();

  for (const app of applications) {
    if (!app.normalizedAddress) continue;
    if (app.declaredAnnualIncome > ceiling) continue;
    const bucket = byAddress.get(app.normalizedAddress) ?? [];
    bucket.push(app);
    byAddress.set(app.normalizedAddress, bucket);
  }

  const findings: RuleFinding[] = [];

  for (const [address, group] of byAddress) {
    const households = new Set(group.map((a) => householdOf.get(a.id) ?? a.id));
    if (households.size < minHouseholds) continue;

    for (const app of group) {
      findings.push({
        applicationId: app.id,
        ruleId: 'ADDRESS_CLUSTER_UNRELATED',
        severity: config.severity,
        weight: config.weight,
        reason:
          `${households.size} separately-filed households give this same address, all declaring ` +
          `incomes below the ${money(ceiling)} eligibility ceiling. This is common in joint ` +
          `families and shared housing, so it is a prompt to check the address, not a finding ` +
          `against the applicant.`,
        evidence: {
          normalizedAddress: address,
          distinctHouseholds: households.size,
          applicationsAtAddress: group.length,
          incomeCeiling: ceiling,
        },
      });
    }
  }

  return findings;
}

/** Certificates for one household issued by different offices. */
export function issuingOfficeMismatch(
  component: HouseholdComponent,
  byId: ReadonlyMap<string, ScorableApplication>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled || component.applicationIds.length < 2) return [];

  const members = component.applicationIds
    .map((id) => byId.get(id))
    .filter((a): a is ScorableApplication => a !== undefined)
    .filter((a) => a.issuingOffice);

  const offices = new Set(members.map((a) => a.issuingOffice!.trim().toLowerCase()));
  if (offices.size < 2) return [];

  return members.map((app) => ({
    applicationId: app.id,
    ruleId: 'ISSUING_OFFICE_MISMATCH',
    severity: config.severity,
    weight: config.weight,
    reason:
      `Certificates in this household come from ${offices.size} different issuing offices ` +
      `(${[...offices].join(', ')}). A family that moved between applications would legitimately ` +
      `use more than one office.`,
    evidence: {
      householdKey: component.key,
      thisOffice: app.issuingOffice,
      distinctOffices: [...offices],
    },
  }));
}

/**
 * Certificate obtained just before the deadline.
 *
 * Never fires alone — `requiresCorroboration` is enforced by the orchestrator
 * below. Siblings applying in one admission cycle obtain certificates days apart,
 * which is normal and evidence of nothing.
 */
export function deadlineProximity(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
  cycleDeadline: string,
): RuleFinding[] {
  if (!config.enabled) return [];

  const windowDays = config.windowDays ?? 14;
  const deadline = new Date(`${cycleDeadline}T00:00:00Z`).getTime();
  if (Number.isNaN(deadline)) return [];

  const findings: RuleFinding[] = [];

  for (const app of applications) {
    if (!app.certificateIssueDate) continue;

    const issued = new Date(`${app.certificateIssueDate}T00:00:00Z`).getTime();
    if (Number.isNaN(issued)) continue;

    const daysBefore = (deadline - issued) / 86_400_000;
    if (daysBefore < 0 || daysBefore > windowDays) continue;

    findings.push({
      applicationId: app.id,
      ruleId: 'DEADLINE_PROXIMITY',
      severity: config.severity,
      weight: config.weight,
      reason:
        `The income certificate was issued ${Math.round(daysBefore)} day(s) before the ` +
        `application deadline. On its own this means nothing — it is shown here only because ` +
        `another signal on this application already required review.`,
      evidence: {
        certificateIssueDate: app.certificateIssueDate,
        cycleDeadline,
        daysBeforeDeadline: Math.round(daysBefore),
      },
    });
  }

  return findings;
}

// ---------------------------------------------------------------- orchestration

export interface EvaluationResult {
  findings: RuleFinding[];
  /** Total weight per application — what becomes `applications.risk_score`. */
  scores: Map<string, number>;
  configVersion: string;
}

/**
 * Run every rule over one cycle's applications and their resolved households.
 *
 * The corroboration pass at the end is what keeps DEADLINE_PROXIMITY from firing
 * alone. It is applied here rather than inside the rule because whether a signal
 * stands alone is a property of the whole evaluation, not of that rule.
 */
export function evaluateRules(
  applications: readonly ScorableApplication[],
  components: readonly HouseholdComponent[],
  config: RulesConfig,
  cycleDeadline: string,
): EvaluationResult {
  const byId = new Map(applications.map((a) => [a.id, a]));
  const householdOf = new Map<string, string>();
  for (const component of components) {
    for (const id of component.applicationIds) householdOf.set(id, component.key);
  }

  const rule = (id: string): RuleConfig =>
    config.rules[id] ?? { enabled: false, severity: 'low', weight: 0 };

  const findings: RuleFinding[] = [];

  for (const component of components) {
    findings.push(
      ...siblingIncomeContradiction(component, byId, rule('SIBLING_INCOME_CONTRADICTION')),
      ...issuingOfficeMismatch(component, byId, rule('ISSUING_OFFICE_MISMATCH')),
    );
  }

  findings.push(
    ...guardianIncomeContradiction(applications, householdOf, rule('GUARDIAN_INCOME_CONTRADICTION')),
    ...addressClusterUnrelated(
      applications,
      householdOf,
      rule('ADDRESS_CLUSTER_UNRELATED'),
      config.scholarshipIncomeCeiling,
    ),
  );

  // Corroboration pass: a rule marked requiresCorroboration is dropped unless the
  // same application already carries a finding from some other rule.
  const corroborated = new Set(findings.map((f) => f.applicationId));

  const proximityConfig = rule('DEADLINE_PROXIMITY');
  for (const finding of deadlineProximity(applications, proximityConfig, cycleDeadline)) {
    if (proximityConfig.requiresCorroboration && !corroborated.has(finding.applicationId)) continue;
    findings.push(finding);
  }

  const scores = new Map<string, number>();
  for (const app of applications) scores.set(app.id, 0);
  for (const finding of findings) {
    scores.set(finding.applicationId, (scores.get(finding.applicationId) ?? 0) + finding.weight);
  }

  return { findings, scores, configVersion: config.version };
}
