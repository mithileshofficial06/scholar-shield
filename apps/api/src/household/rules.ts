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

import {
  compareFields,
  DETAIL_FIELDS,
  HOLDER_FIELDS,
  editingSoftwareCheck,
  elaCheck,
  incomeWordsCheck,
  NUMBER_FIELDS,
  type CertificateEvidence,
  type ComparedField,
  type ComparisonOptions,
} from './certificate.js';
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
  /** Below this OCR confidence a figure read off a document is not relied on. */
  minOcrConfidence?: number;
  /** Name parts must agree at least this well to count as the same name. */
  minNameSimilarity?: number;
  /** ELA tamper score at or above which a document is flagged. */
  minTamperScore?: number;
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
  normalizedGuardianPhone: string | null;
  issuingOffice: string | null;
  /** ISO date, or null when OCR could not read one. */
  certificateIssueDate: string | null;
  certificateId: string | null;
  /**
   * The annual income printed on the applicant's own uploaded certificate, as OCR
   * read it. Absent for applications with no document (a CSV import) or whose
   * document has not been read yet.
   */
  certificateIncome?: { value: number; confidence: number } | null;
  /** Declared particulars the certificate is compared against. */
  guardianName?: string | null;
  district?: string | null;
  pincode?: string | null;
  /** Everything the pipeline learned from the uploaded certificate. */
  certificate?: CertificateEvidence | null;
  /** The latest government-record result a reviewer recorded. */
  verificationStatus?: 'manual_check_required' | 'verified' | 'mismatch' | 'unavailable' | null;
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
 * The same certificate ID number appearing on more than one application.
 *
 * A genuine income certificate has a unique serial number issued once by one
 * office. Reuse means one certificate — genuine or forged — was submitted twice,
 * possibly under different applicant names. Unlike the income-comparison rules
 * above, this needs no tolerance: the identifier either matches exactly or it
 * doesn't, so it fires at high severity even for a single duplicate pair.
 */
export function duplicateCertificateId(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const byCertificate = new Map<string, ScorableApplication[]>();
  for (const app of applications) {
    const id = app.certificateId?.trim();
    if (!id) continue;
    const bucket = byCertificate.get(id) ?? [];
    bucket.push(app);
    byCertificate.set(id, bucket);
  }

  const findings: RuleFinding[] = [];

  for (const [certificateId, group] of byCertificate) {
    if (group.length < 2) continue;

    for (const app of group) {
      const others = group.filter((a) => a.id !== app.id);
      findings.push({
        applicationId: app.id,
        ruleId: 'DUPLICATE_CERTIFICATE_ID',
        severity: config.severity,
        weight: config.weight,
        reason:
          `Certificate ${certificateId} also appears on ${others.length} other application(s) ` +
          `(${others.map((o) => o.applicantName).join(', ')}). One certificate serial number ` +
          `should be issued to one household once.`,
        evidence: {
          certificateId,
          otherApplicationIds: others.map((o) => o.id),
          otherApplicantNames: others.map((o) => o.applicantName),
        },
      });
    }
  }

  return findings;
}

/**
 * Members of one resolved household declaring different family sizes.
 *
 * Several scholarship schemes weigh eligibility by per-capita income (income ÷
 * family size), so understating family size on one certificate while the true
 * size is visible from a sibling's certificate lowers the computed per-capita
 * figure without touching the income line itself. `declaredFamilySize` is
 * collected but was previously unused by any rule.
 */
export function familySizeContradiction(
  component: HouseholdComponent,
  byId: ReadonlyMap<string, ScorableApplication>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled || component.applicationIds.length < 2) return [];

  const members = component.applicationIds
    .map((id) => byId.get(id))
    .filter((a): a is ScorableApplication => a !== undefined);

  const sizes = new Set(members.map((a) => a.declaredFamilySize));
  if (sizes.size < 2) return [];

  return members.map((app) => ({
    applicationId: app.id,
    ruleId: 'FAMILY_SIZE_CONTRADICTION',
    severity: config.severity,
    weight: config.weight,
    reason:
      `This household's certificates disagree on family size — this application declares ` +
      `${app.declaredFamilySize}, while others in the same household declare ` +
      `${[...sizes].filter((s) => s !== app.declaredFamilySize).join(', ')}. Family size feeds ` +
      `per-capita income eligibility, so a shrunk figure on one certificate changes the outcome.`,
    evidence: {
      householdKey: component.key,
      thisFamilySize: app.declaredFamilySize,
      distinctFamilySizes: [...sizes],
    },
  }));
}

/**
 * The same contact phone number across applications resolved to *different*
 * households.
 *
 * A phone number is harder to vary across a batch of fraudulent applications
 * than a guardian's name or a street address, so it survives spoofing that
 * defeats `GUARDIAN_INCOME_CONTRADICTION` (different name) and
 * `ADDRESS_CLUSTER_UNRELATED` (different address). Same-household pairs are
 * skipped for the same reason as the guardian rule — one fact, one flag.
 */
export function sharedContactUnrelatedHouseholds(
  applications: readonly ScorableApplication[],
  householdOf: ReadonlyMap<string, string>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const byPhone = new Map<string, ScorableApplication[]>();
  for (const app of applications) {
    if (!app.normalizedGuardianPhone) continue;
    const bucket = byPhone.get(app.normalizedGuardianPhone) ?? [];
    bucket.push(app);
    byPhone.set(app.normalizedGuardianPhone, bucket);
  }

  const findings: RuleFinding[] = [];
  const flagged = new Set<string>();

  for (const [, group] of byPhone) {
    if (group.length < 2) continue;

    const households = new Set(group.map((a) => householdOf.get(a.id) ?? a.id));
    if (households.size < 2) continue;

    for (const app of group) {
      if (flagged.has(app.id)) continue;
      flagged.add(app.id);

      const others = group.filter((a) => a.id !== app.id);
      findings.push({
        applicationId: app.id,
        ruleId: 'SHARED_CONTACT_UNRELATED_HOUSEHOLDS',
        severity: config.severity,
        weight: config.weight,
        reason:
          `The contact number on this application also appears on ${others.length} ` +
          `application(s) resolved to a different household (${others.map((o) => o.applicantName).join(', ')}). ` +
          `A shared address can be explained by joint housing; a shared phone number across ` +
          `unrelated families is harder to.`,
        evidence: {
          householdKey: householdOf.get(app.id) ?? app.id,
          distinctHouseholds: households.size,
          otherApplicationIds: others.map((o) => o.id),
          otherApplicantNames: others.map((o) => o.applicantName),
        },
      });
    }
  }

  return findings;
}

/**
 * An application declaring less income than its own certificate shows.
 *
 * Every other income rule needs a second application to compare against, so an
 * applicant filing alone could declare any figure at all. This compares the form
 * with the document uploaded beside it, which needs no household.
 *
 * One direction only. Declaring more than the certificate works against the
 * applicant, and is far more often OCR noise or rounding than a lie. The same
 * two-part tolerance as the household rules applies, and a figure OCR was unsure
 * of is not used at all — a misread digit must not put an honest applicant at
 * the top of the queue. The reviewer has the document beside the flag to check.
 */
export function declaredIncomeBelowCertificate(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
  ceiling: number,
): RuleFinding[] {
  if (!config.enabled) return [];

  const minConfidence = config.minOcrConfidence ?? 0.8;
  const findings: RuleFinding[] = [];

  for (const app of applications) {
    const certificate = app.certificateIncome;
    if (!certificate || certificate.confidence < minConfidence) continue;
    if (certificate.value <= app.declaredAnnualIncome) continue;
    if (!exceedsTolerance(app.declaredAnnualIncome, certificate.value, config)) continue;

    const crossesCeiling = certificate.value > ceiling && app.declaredAnnualIncome <= ceiling;

    findings.push({
      applicationId: app.id,
      ruleId: 'DECLARED_INCOME_BELOW_CERTIFICATE',
      severity: config.severity,
      weight: config.weight,
      reason:
        `This application declares a household income of ${money(app.declaredAnnualIncome)}, but ` +
        `the certificate uploaded with it reads ${money(certificate.value)} — ` +
        `${describeGap(app.declaredAnnualIncome, certificate.value)} more.` +
        (crossesCeiling
          ? ` The certificate's figure is above the ${money(ceiling)} eligibility ceiling; the declared one is not.`
          : '') +
        ` Check the figure on the document itself: it was read by OCR.`,
      evidence: {
        declaredIncome: app.declaredAnnualIncome,
        certificateIncome: certificate.value,
        ocrConfidence: certificate.confidence,
        differenceAbsolute: certificate.value - app.declaredAnnualIncome,
        incomeCeiling: ceiling,
        crossesCeiling,
      },
    });
  }

  return findings;
}

// ------------------------------------------- the certificate against the form

function comparisonOptions(config: RuleConfig): ComparisonOptions {
  return { minOcrConfidence: config.minOcrConfidence ?? 0.8, minNameSimilarity: config.minNameSimilarity ?? 0.25 };
}

/**
 * One rule per group of certificate fields, each flagging once per application
 * with every field in the group that failed. The comparison itself lives in
 * certificate.ts, shared with the reviewer's checklist.
 */
function certificateFieldRule(ruleId: string, fields: readonly ComparedField[], describe: string) {
  return (applications: readonly ScorableApplication[], config: RuleConfig): RuleFinding[] => {
    if (!config.enabled) return [];
    const findings: RuleFinding[] = [];

    for (const app of applications) {
      if (!app.certificate) continue;
      const failed = compareFields(fields, app, app.certificate, comparisonOptions(config)).filter(
        (c) => c.status === 'fail',
      );
      if (failed.length === 0) continue;

      findings.push({
        applicationId: app.id,
        ruleId,
        severity: config.severity,
        weight: config.weight,
        reason:
          `${describe} ` +
          failed.map((c) => `${c.label}: the form says "${c.declared}", the certificate reads "${c.certificate}".`).join(' ') +
          ' Check the document itself: the certificate side was read by OCR.',
        evidence: {
          mismatches: failed.map((c) => ({
            field: c.field,
            declared: c.declared,
            certificate: c.certificate,
            ocrConfidence: c.confidence,
          })),
        },
      });
    }
    return findings;
  };
}

/** The certificate names a different applicant or guardian — possibly someone else's certificate. */
export const certificateHolderMismatch = certificateFieldRule(
  'CERTIFICATE_HOLDER_MISMATCH',
  HOLDER_FIELDS,
  'The certificate appears to be issued to a different person than this application names.',
);

/** The certificate uploaded is not the one whose number the applicant gave. */
export const certificateNumberMismatch = certificateFieldRule(
  'CERTIFICATE_NUMBER_MISMATCH',
  NUMBER_FIELDS,
  'The uploaded certificate is not the one whose number the application gives.',
);

/** District, PIN or family size on the certificate disagree with the form. */
export const certificateDetailsMismatch = certificateFieldRule(
  'CERTIFICATE_DETAILS_MISMATCH',
  DETAIL_FIELDS,
  'The certificate describes the household differently from the form.',
);

/** Income in figures and in words disagree on the certificate itself. */
export function certificateIncomeWordsMismatch(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];
  const findings: RuleFinding[] = [];
  for (const app of applications) {
    const check = incomeWordsCheck(app.certificate, comparisonOptions(config));
    if (check.status !== 'fail') continue;
    findings.push({
      applicationId: app.id,
      ruleId: 'CERTIFICATE_INCOME_WORDS_MISMATCH',
      severity: config.severity,
      weight: config.weight,
      reason: check.reason,
      evidence: { incomeInFigures: check.figure, incomeInWords: check.words },
    });
  }
  return findings;
}

/**
 * The metadata names an image or PDF editor — or, only when the config sets
 * minTamperScore, error level analysis found an anomalous region (see elaCheck
 * for why v3 does not). Weighted below the high-severity band on purpose
 * (PROJECT_REPORT.md §5 Tier 2): it can raise a document in the queue, never
 * put it in the high band alone.
 */
export function documentTamperSignal(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];
  const threshold = config.minTamperScore ?? null;
  const findings: RuleFinding[] = [];
  for (const app of applications) {
    const editors = editingSoftwareCheck(app.certificate);
    const ela = elaCheck(app.certificate, threshold);
    const failed = [editors, ela].filter((check) => check.status === 'fail');
    if (failed.length === 0) continue;
    findings.push({
      applicationId: app.id,
      ruleId: 'DOCUMENT_TAMPER_SIGNAL',
      severity: config.severity,
      weight: config.weight,
      reason: `${failed.map((check) => check.reason).join(' ')} Look at the document itself.`,
      evidence: { editingSoftware: editors.editors, tamperScore: ela.tamperScore, threshold },
    });
  }
  return findings;
}

/**
 * A reviewer checked the state portal and recorded that the certificate does
 * not match the government record. The one input here a human has confirmed,
 * so it carries the most weight of any rule — and it is still a queue
 * position, not a rejection. The reviewer who recorded it still decides.
 */
export function governmentRecordMismatch(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];
  return applications
    .filter((app) => app.verificationStatus === 'mismatch')
    .map((app) => ({
      applicationId: app.id,
      ruleId: 'GOVERNMENT_RECORD_MISMATCH',
      severity: config.severity,
      weight: config.weight,
      reason:
        'A reviewer checked this certificate on the state verification portal and recorded that it does ' +
        'not match the government record (not found, or different details).',
      evidence: { verificationStatus: app.verificationStatus },
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
      ...familySizeContradiction(component, byId, rule('FAMILY_SIZE_CONTRADICTION')),
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
    ...duplicateCertificateId(applications, rule('DUPLICATE_CERTIFICATE_ID')),
    ...sharedContactUnrelatedHouseholds(
      applications,
      householdOf,
      rule('SHARED_CONTACT_UNRELATED_HOUSEHOLDS'),
    ),
    ...declaredIncomeBelowCertificate(
      applications,
      rule('DECLARED_INCOME_BELOW_CERTIFICATE'),
      config.scholarshipIncomeCeiling,
    ),
    ...certificateIncomeWordsMismatch(applications, rule('CERTIFICATE_INCOME_WORDS_MISMATCH')),
    ...certificateHolderMismatch(applications, rule('CERTIFICATE_HOLDER_MISMATCH')),
    ...certificateNumberMismatch(applications, rule('CERTIFICATE_NUMBER_MISMATCH')),
    ...certificateDetailsMismatch(applications, rule('CERTIFICATE_DETAILS_MISMATCH')),
    ...documentTamperSignal(applications, rule('DOCUMENT_TAMPER_SIGNAL')),
    ...governmentRecordMismatch(applications, rule('GOVERNMENT_RECORD_MISMATCH')),
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
