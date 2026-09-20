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
  documentIdentityCheck,
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
import { LINK_THRESHOLD, type PairResolution } from './resolve.js';

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
  /** Words needed on a page before its missing fields mean anything. */
  minWordCount?: number;
  /** Identifying fields a document must carry to be an income certificate. */
  minIdentifyingFields?: number;
  /** ELA tamper score at or above which a document is flagged. */
  minTamperScore?: number;

  // --- population-level rules (Tier 1b) ---
  /** Width of the band below the ceiling, as a percentage of the ceiling. */
  bunchingBandPercent?: number;
  /** Applications needed inside the band before density is even considered. */
  minBandCount?: number;
  /** How many times denser the band must be than the band below it. */
  bunchingRatio?: number;
  /** Widest serial-number span still counted as one issuance run. */
  maxSerialSpan?: number;
  /** An income is "round" when divisible by this. */
  roundIncomeStep?: number;
  /** Resolution score below which a pair is unrelated rather than a near miss. */
  nearMissFloor?: number;
  /** Independent fields that must near-miss together before it means anything. */
  minNearMissFields?: number;
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


/**
 * The uploaded file is legible and is not an income certificate.
 *
 * Kept with the pairwise rules rather than in Tier 1b because it is a fact about
 * THIS application's own document — the applicant chose what to upload — and it
 * is weighted accordingly. See documentIdentityCheck in certificate.ts for why
 * this fails only on a clearly-read page and skips on every poor one.
 */
export function documentNotACertificate(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const findings: RuleFinding[] = [];

  for (const app of applications) {
    const result = documentIdentityCheck(app.certificate ?? null, {
      minPageConfidence: config.minOcrConfidence ?? 0.8,
      minWordCount: config.minWordCount ?? 40,
      minIdentifyingFields: config.minIdentifyingFields ?? 3,
    });
    if (result.status !== 'fail') continue;

    findings.push({
      applicationId: app.id,
      ruleId: 'DOCUMENT_NOT_A_CERTIFICATE',
      severity: config.severity,
      weight: config.weight,
      reason: result.reason,
      evidence: {
        identifyingFieldsFound: result.found,
        identifyingFieldsExpected: result.expected,
        pageConfidence: app.certificate?.pageConfidence ?? null,
        wordCount: app.certificate?.wordCount ?? null,
      },
    });
  }

  return findings;
}

// ------------------------------------------- Tier 1b: population-level rules
//
// Everything above this line compares an application against ONE other thing:
// a sibling, a guardian, its own certificate. That shape has a blind spot no
// amount of tuning fixes — a fraud visible only in the SHAPE OF A POPULATION
// produces no contradicting pair, so no pairwise rule can reach it.
//
// The four rules below read a whole cycle at once. Each is derived from a fraud
// mechanism named in PROJECT_REPORT.md §1 — threshold gaming, bulk issuance,
// certificate mills, deliberate identity fragmentation — and not from any
// observed miss. db/seed/README-holdout.md explains why that distinction is
// load-bearing rather than pedantic.
//
// They are weighted BELOW the pairwise rules deliberately. A pairwise rule points
// at a contradiction the applicant themselves produced. These point at the
// company an applicant keeps, which an honest applicant neither chooses nor can
// contest. None may reach highSeverityScoreThreshold alone.

/** The digits at the tail of a serial: `TN-CHN-2025-204471` -> prefix TNCHN, 204471. */
function serialTail(certificateId: string | null): { prefix: string; value: number } | null {
  if (!certificateId) return null;
  const match = /^(.*?)(\d+)\s*$/.exec(certificateId.trim().toUpperCase());
  if (!match) return null;
  const value = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(value)) return null;
  return { prefix: match[1]!.replace(/[^A-Z]/g, ''), value };
}

/**
 * Declared incomes bunching in a narrow band just under the eligibility ceiling.
 *
 * THE MECHANISM
 * -------------
 * Eligibility is a cliff: at the ceiling you qualify, one rupee over you do not.
 * A figure invented to qualify gets placed just under that cliff, because a
 * fabricator wants the largest income the rule still allows. Real incomes do not
 * know where the cliff is, so a genuine population thins out smoothly as it
 * approaches the ceiling. A spike in the last few percent below the line is the
 * fingerprint of figures chosen rather than earned.
 *
 * This is the bunching estimator from public economics — the test applied to
 * tax-bracket and means-test data — narrowed to one admission cycle.
 *
 * WHY IT IS WEIGHTED LOWEST, AND FLAGS A BAND RATHER THAN A PERSON
 * ----------------------------------------------------------------
 * Some households genuinely earn just under the line. Being near it is not
 * misconduct, and "other people declared what you declared" is not something an
 * applicant can answer. So the rule fires only when the band is anomalously dense
 * against the band below it — the comparison is the evidence, not the position —
 * and carries the lowest weight in the set.
 */
export function incomeThresholdBunching(
  applications: readonly ScorableApplication[],
  config: RuleConfig,
  ceiling: number,
): RuleFinding[] {
  if (!config.enabled || ceiling <= 0) return [];

  const bandPercent = config.bunchingBandPercent ?? 8;
  const minCount = config.minBandCount ?? 4;
  const ratio = config.bunchingRatio ?? 2.5;

  const bandWidth = (ceiling * bandPercent) / 100;
  const bandFloor = ceiling - bandWidth;
  // The equal-width band immediately below, standing in as the counterfactual.
  const referenceFloor = bandFloor - bandWidth;

  const inBand = applications.filter(
    (a) => a.declaredAnnualIncome > bandFloor && a.declaredAnnualIncome <= ceiling,
  );
  const inReference = applications.filter(
    (a) => a.declaredAnnualIncome > referenceFloor && a.declaredAnnualIncome <= bandFloor,
  );

  if (inBand.length < minCount) return [];
  // max(...,1): against an empty reference band any occupancy is infinitely
  // dense, which would fire on a small cycle where the band below simply has
  // nobody in it.
  if (inBand.length < ratio * Math.max(inReference.length, 1)) return [];

  const observedRatio = (inBand.length / Math.max(inReference.length, 1)).toFixed(1);

  return inBand.map((app) => ({
    applicationId: app.id,
    ruleId: 'INCOME_THRESHOLD_BUNCHING',
    severity: config.severity,
    weight: config.weight,
    reason:
      `This application declares ${money(app.declaredAnnualIncome)}, inside the ${bandPercent}% band just ` +
      `below the ${money(ceiling)} eligibility ceiling. ${inBand.length} applications this cycle sit in that ` +
      `band against ${inReference.length} in the equally wide band beneath it — ${observedRatio}x the density. ` +
      `A population of real incomes thins out towards a ceiling it cannot see; a cluster pressed against the ` +
      `line is the shape of figures picked to qualify. This describes the group, not this applicant, who may ` +
      `simply earn what they say.`,
    evidence: {
      declaredAnnualIncome: app.declaredAnnualIncome,
      ceiling,
      bandFloor,
      bandCount: inBand.length,
      referenceBandCount: inReference.length,
      densityRatio: Number(observedRatio),
    },
  }));
}

/**
 * Near-consecutive certificate serials issued by one office to unrelated households.
 *
 * THE MECHANISM
 * -------------
 * An office issues serials in order as people walk in. Genuine applicants from one
 * taluk therefore hold numbers scattered across a whole year of issuance. A block
 * of certificates obtained in one transaction — bulk issuance, the certificate
 * mill — carries a tight run, because they were printed back to back.
 *
 * Same household is excluded. Siblings who went to the office together legitimately
 * walk out with consecutive numbers, and that is much the likeliest innocent
 * explanation for adjacency.
 */
export function certificateSerialAdjacency(
  applications: readonly ScorableApplication[],
  householdOf: ReadonlyMap<string, string>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const maxSpan = config.maxSerialSpan ?? 12;
  const minRun = config.minDistinctHouseholds ?? 3;

  // Keyed by office AND serial prefix: two offices sharing a numbering series
  // would otherwise look adjacent while being entirely unrelated.
  const bySeries = new Map<string, { app: ScorableApplication; serial: number }[]>();
  for (const app of applications) {
    const parsed = serialTail(app.certificateId);
    if (!parsed || !app.issuingOffice) continue;
    const key = `${app.issuingOffice.trim().toLowerCase()}::${parsed.prefix}`;
    const bucket = bySeries.get(key) ?? [];
    bucket.push({ app, serial: parsed.value });
    bySeries.set(key, bucket);
  }

  const findings: RuleFinding[] = [];

  for (const [key, entries] of bySeries) {
    if (entries.length < minRun) continue;
    entries.sort((a, b) => a.serial - b.serial);

    // Sliding window over the sorted serials, reported at its widest.
    let start = 0;
    for (let end = 0; end < entries.length; end += 1) {
      while (entries[end]!.serial - entries[start]!.serial > maxSpan) start += 1;

      const nextStillFits =
        end + 1 < entries.length && entries[end + 1]!.serial - entries[start]!.serial <= maxSpan;
      if (nextStillFits) continue;

      const window = entries.slice(start, end + 1);
      const households = new Set(window.map((e) => householdOf.get(e.app.id) ?? e.app.id));
      if (households.size < minRun) continue;

      const span = window[window.length - 1]!.serial - window[0]!.serial;
      const office = window[0]!.app.issuingOffice;

      for (const entry of window) {
        findings.push({
          applicationId: entry.app.id,
          ruleId: 'CERTIFICATE_SERIAL_ADJACENCY',
          severity: config.severity,
          weight: config.weight,
          reason:
            `This certificate's serial (${entry.app.certificateId}) falls in a run of ${window.length} ` +
            `certificates from ${office} spanning just ${span} numbers, held by ${households.size} unrelated ` +
            `households applying to the same cycle. An office issues serials in order as applicants arrive, ` +
            `so genuine certificates from one office spread across a year of issuance. A tight run across ` +
            `unrelated families is what a block issued in one sitting looks like.`,
          evidence: {
            certificateId: entry.app.certificateId,
            issuingOffice: office,
            serialRunLength: window.length,
            serialSpan: span,
            distinctHouseholds: households.size,
            seriesKey: key,
          },
        });
      }
    }
  }

  return findings;
}

/**
 * One income figure, repeated exactly across unrelated households from one office.
 *
 * THE MECHANISM
 * -------------
 * A certificate mill does not assess an income per family. It reuses a stock
 * figure that clears the means test, and that figure is almost always round.
 * Incomes from unrelated households scatter, because they are wages rather than
 * a template.
 *
 * All three signatures are required together, because each alone is innocent:
 * incomes ARE often rounded, families DO share an office, and two households CAN
 * coincide on a figure. Identical AND round AND clustered at one office is the
 * combination a payroll does not produce.
 */
export function identicalRoundIncomeCluster(
  applications: readonly ScorableApplication[],
  householdOf: ReadonlyMap<string, string>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const step = config.roundIncomeStep ?? 10_000;
  const minHouseholds = config.minDistinctHouseholds ?? 3;

  const groups = new Map<string, ScorableApplication[]>();
  for (const app of applications) {
    if (!app.issuingOffice) continue;
    if (app.declaredAnnualIncome <= 0) continue;
    if (app.declaredAnnualIncome % step !== 0) continue;
    const key = `${app.issuingOffice.trim().toLowerCase()}::${app.declaredAnnualIncome}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(app);
    groups.set(key, bucket);
  }

  const findings: RuleFinding[] = [];

  for (const members of groups.values()) {
    const households = new Set(members.map((a) => householdOf.get(a.id) ?? a.id));
    if (households.size < minHouseholds) continue;

    const value = members[0]!.declaredAnnualIncome;
    const office = members[0]!.issuingOffice;

    for (const app of members) {
      findings.push({
        applicationId: app.id,
        ruleId: 'IDENTICAL_ROUND_INCOME_CLUSTER',
        severity: config.severity,
        weight: config.weight,
        reason:
          `${households.size} unrelated households holding certificates from ${office} all declare exactly ` +
          `${money(value)} — round to the nearest ${money(step)}. Wages from unrelated families scatter; one ` +
          `office issuing one repeated round figure is the signature of a stock number rather than an assessed ` +
          `income. Worth checking the certificates in this group together, since no single one looks wrong alone.`,
        evidence: {
          declaredAnnualIncome: value,
          issuingOffice: office,
          distinctHouseholds: households.size,
          roundingStep: step,
          peerApplicationIds: members.filter((m) => m.id !== app.id).map((m) => m.id),
        },
      });
    }
  }

  return findings;
}

/**
 * Pairs sitting deliberately just under the household-matching bar.
 *
 * THE MECHANISM
 * -------------
 * Someone who knows applications are cross-matched fragments an identity: vary the
 * spelling of the guardian's name, move the address one street over, change the
 * handset. Each field is altered just enough to fall under its own threshold, so
 * the pair never merges and no household rule ever compares the two.
 *
 * That evasion leaves a shape of its own. An unrelated pair scores near zero on
 * everything, because a stranger's name and address are not nearly yours. A genuine
 * household clears the bar. The gap between the two — close on SEVERAL independent
 * fields at once and over the line on none — is not where honest data lands. It is
 * where data lands that was edited until it stopped matching.
 *
 * Requiring two independent fields is the whole precision story. One near miss is
 * two people in a district sharing a common name, which is ordinary in exactly the
 * naming conventions PROJECT_REPORT.md §6 warns about.
 */
export function householdFragmentation(
  pairs: readonly PairResolution[],
  byId: ReadonlyMap<string, ScorableApplication>,
  config: RuleConfig,
): RuleFinding[] {
  if (!config.enabled) return [];

  const floor = config.nearMissFloor ?? 0.38;
  const minFields = config.minNearMissFields ?? 2;
  const findings: RuleFinding[] = [];
  const reported = new Set<string>();

  for (const pair of pairs) {
    if (pair.linked) continue;
    if (pair.score < floor || pair.score >= LINK_THRESHOLD) continue;
    if (pair.edges.length < minFields) continue;

    const a = byId.get(pair.applicationAId);
    const b = byId.get(pair.applicationBId);
    if (!a || !b) continue;

    const fields = pair.edges
      .map((e) => `${e.matchField.replace(/_/g, ' ')} ${Math.round(e.similarity * 100)}%`)
      .join(', ');

    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const key = `${self.id}::${other.id}`;
      if (reported.has(key)) continue;
      reported.add(key);

      findings.push({
        applicationId: self.id,
        ruleId: 'HOUSEHOLD_FRAGMENTATION',
        severity: config.severity,
        weight: config.weight,
        reason:
          `This application and ${other.applicantName}'s resolve to ${pair.score.toFixed(2)} against the ` +
          `${LINK_THRESHOLD} needed to be treated as one household — close on ${pair.edges.length} independent ` +
          `fields (${fields}) and over the line on none, so no household rule ever compared them. Unrelated ` +
          `applications do not usually land here: a stranger matches on nothing. Sitting just under the bar on ` +
          `several fields at once is what an identity edited until it stops matching looks like — though two ` +
          `common names in one district produce it honestly too.`,
        evidence: {
          resolutionScore: pair.score,
          linkThreshold: LINK_THRESHOLD,
          otherApplicationId: other.id,
          otherApplicantName: other.applicantName,
          nearMissFields: pair.edges.map((e) => ({
            field: e.matchField,
            similarity: e.similarity,
          })),
        },
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------- orchestration

/**
 * The Tier 1b rule ids, named once so the corroboration pass below and any
 * future caller agree on what counts as a population signal rather than a fact
 * about one application.
 */
export const POPULATION_RULES: ReadonlySet<string> = new Set([
  'INCOME_THRESHOLD_BUNCHING',
  'CERTIFICATE_SERIAL_ADJACENCY',
  'IDENTICAL_ROUND_INCOME_CLUSTER',
  'HOUSEHOLD_FRAGMENTATION',
]);

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
  /**
   * Every scored pair, linked or not. HOUSEHOLD_FRAGMENTATION is the only rule
   * that reads the ones that did NOT link, so it is the only reason this is
   * here; callers with no resolver output pass nothing and lose just that rule.
   */
  pairs: readonly PairResolution[] = [],
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
    ...documentNotACertificate(applications, rule('DOCUMENT_NOT_A_CERTIFICATE')),
    ...governmentRecordMismatch(applications, rule('GOVERNMENT_RECORD_MISMATCH')),
  );

  // Tier 1b. Population-level, so they run once over the whole cycle rather
  // than per component — a cycle is the smallest set in which any of these
  // shapes exists at all.
  findings.push(
    ...incomeThresholdBunching(
      applications,
      rule('INCOME_THRESHOLD_BUNCHING'),
      config.scholarshipIncomeCeiling,
    ),
    ...certificateSerialAdjacency(
      applications,
      householdOf,
      rule('CERTIFICATE_SERIAL_ADJACENCY'),
    ),
    ...identicalRoundIncomeCluster(
      applications,
      householdOf,
      rule('IDENTICAL_ROUND_INCOME_CLUSTER'),
    ),
    ...householdFragmentation(pairs, byId, rule('HOUSEHOLD_FRAGMENTATION')),
  );

  // Corroboration pass: a rule marked requiresCorroboration is dropped unless the
  // same application already carries a finding from some other rule.
  //
  // Tier 1b findings do NOT corroborate. They describe a population an applicant
  // did not choose to belong to, and letting one satisfy another weak rule's
  // corroboration requirement would let two things that are individually not
  // evidence combine into something that looks like it. Corroboration has to
  // mean a second fact about THIS application.
  const corroborated = new Set(
    findings.filter((f) => !POPULATION_RULES.has(f.ruleId)).map((f) => f.applicationId),
  );

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
