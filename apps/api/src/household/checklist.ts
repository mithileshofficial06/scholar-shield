/**
 * The reviewer's checklist: every check, for one application, with its outcome.
 *
 * Flags are the failures. This adds everything else a reviewer needs to trust
 * the absence of a flag: which checks ran and passed, which could not run and
 * why, and which are still waiting — on the pipeline, or on a person.
 *
 * Pure: the route loads the rows, this decides. The certificate checks call the
 * same functions the rules call (certificate.ts), and the household checks read
 * the flags the last scoring pass wrote, so the checklist cannot report a pass
 * where the queue carries a flag.
 */

import type { ApplicationCheck, ApplicationChecklist, CheckStatus } from '@scholarshield/shared';

import {
  compareField,
  incomeWordsCheck,
  tamperCheck,
  type ComparedField,
  type ComparisonOptions,
} from './certificate.js';
import { declaredIncomeBelowCertificate, type RuleConfig, type RulesConfig, type ScorableApplication } from './rules.js';

export interface StageRun {
  stage: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'dead_lettered';
  lastError: string | null;
}

export interface ChecklistFlag {
  ruleId: string;
  ruleConfigVersion: string;
  severity: 'low' | 'medium' | 'high';
  reason: string;
}

export interface ChecklistInput {
  application: ScorableApplication;
  /** Whether a certificate was uploaded at all (read or not). */
  hasDocument: boolean;
  /** OCR read confidence for the whole page, when OCR has run. */
  pageConfidence: number | null;
  stages: StageRun[];
  flags: ChecklistFlag[];
  /** Applications resolved into this one's household, itself included. */
  householdSize: number;
  scored: boolean;
  manualCheckUrl: string | null;
  config: RulesConfig;
}

const STAGE_COUNT = 5;

const FIELD_RULE: Record<ComparedField, string> = {
  applicant_name: 'CERTIFICATE_HOLDER_MISMATCH',
  guardian_name: 'CERTIFICATE_HOLDER_MISMATCH',
  certificate_id: 'CERTIFICATE_NUMBER_MISMATCH',
  district: 'CERTIFICATE_DETAILS_MISMATCH',
  pincode: 'CERTIFICATE_DETAILS_MISMATCH',
  family_size: 'CERTIFICATE_DETAILS_MISMATCH',
};

/** Cross-application rules, and what each needs before it can say anything. */
const HOUSEHOLD_RULES: { ruleId: string; label: string; needs: 'household' | 'certificateId' | 'phone' | 'issueDate' | null }[] = [
  { ruleId: 'SIBLING_INCOME_CONTRADICTION', label: 'Income agrees with siblings in the same household', needs: 'household' },
  { ruleId: 'FAMILY_SIZE_CONTRADICTION', label: 'Family size agrees across the household', needs: 'household' },
  { ruleId: 'ISSUING_OFFICE_MISMATCH', label: 'One issuing office across the household', needs: 'household' },
  { ruleId: 'GUARDIAN_INCOME_CONTRADICTION', label: 'Guardian does not appear elsewhere with a different income', needs: null },
  { ruleId: 'DUPLICATE_CERTIFICATE_ID', label: 'Certificate number not used by another application', needs: 'certificateId' },
  { ruleId: 'SHARED_CONTACT_UNRELATED_HOUSEHOLDS', label: 'Phone number not shared with an unrelated household', needs: 'phone' },
  { ruleId: 'ADDRESS_CLUSTER_UNRELATED', label: 'Address not shared by several unrelated households', needs: null },
  { ruleId: 'DEADLINE_PROXIMITY', label: 'Certificate not obtained just before the deadline', needs: 'issueDate' },
];

function ruleConfig(config: RulesConfig, ruleId: string): RuleConfig | null {
  const rule = config.rules[ruleId];
  return rule?.enabled ? rule : null;
}

export function buildChecklist(input: ChecklistInput): ApplicationChecklist {
  const { application: app, config } = input;
  const checks: ApplicationCheck[] = [];
  const flagFor = (ruleId: string) =>
    input.flags.find((f) => f.ruleId === ruleId && f.ruleConfigVersion === config.version);

  const add = (check: Omit<ApplicationCheck, 'ruleId' | 'severity'> & { ruleId?: string }) => {
    const rule = check.ruleId ? config.rules[check.ruleId] : undefined;
    checks.push({
      ...check,
      ruleId: check.ruleId ?? null,
      severity: rule ? rule.severity : null,
    });
  };

  // ------------------------------------------------------------ the document

  const failedStage = input.stages.find((s) => s.status === 'dead_lettered' || s.status === 'failed');
  const doneStages = input.stages.filter((s) => s.status === 'succeeded').length;

  add({
    id: 'document.uploaded',
    group: 'document',
    label: 'Income certificate uploaded',
    status: input.hasDocument ? 'pass' : 'fail',
    detail: input.hasDocument
      ? 'A certificate was uploaded with this application.'
      : 'No certificate was uploaded, so none of the document checks below could run.',
  });

  add({
    id: 'document.processed',
    group: 'document',
    label: 'Document processed by every pipeline stage',
    status: !input.hasDocument
      ? 'skipped'
      : failedStage?.status === 'dead_lettered'
        ? 'fail'
        : doneStages >= STAGE_COUNT
          ? 'pass'
          : 'pending',
    detail: !input.hasDocument
      ? 'No document to process.'
      : failedStage?.status === 'dead_lettered'
        ? `Stopped at ${failedStage.stage} after exhausting its retries: ${failedStage.lastError ?? 'no error recorded'}. Retry it from the dead-letter list.`
        : doneStages >= STAGE_COUNT
          ? 'OCR, forensics, verification link, household resolution and scoring all completed.'
          : `${doneStages} of ${STAGE_COUNT} stages completed so far${failedStage ? `; ${failedStage.stage} is retrying` : ''}.`,
  });

  const certificate = app.certificate ?? null;
  add({
    id: 'document.readable',
    group: 'document',
    label: 'Certificate text could be read',
    status: !input.hasDocument ? 'skipped' : certificate ? 'pass' : 'pending',
    detail: !input.hasDocument
      ? 'No document to read.'
      : certificate
        ? `OCR read the page at ${Math.round((input.pageConfidence ?? 0) * 100)}% average confidence. Fields below that confidence floor are skipped, never failed.`
        : 'OCR has not finished reading the certificate yet.',
  });

  // ------------------------------------------------- the certificate vs the form

  const pending = (id: string, label: string, ruleId: string) =>
    add({
      id,
      group: 'certificate',
      label,
      ruleId,
      status: input.hasDocument ? 'pending' : 'skipped',
      detail: input.hasDocument ? 'Waiting for OCR to read the certificate.' : 'No certificate was uploaded.',
    });

  const fields: ComparedField[] = ['applicant_name', 'guardian_name', 'certificate_id', 'district', 'pincode', 'family_size'];
  for (const field of fields) {
    const ruleId = FIELD_RULE[field];
    const rule = ruleConfig(config, ruleId);
    const id = `certificate.${field}`;
    const label = `${compareField(field, app, null).label} matches the certificate`;

    if (!rule) {
      add({ id, group: 'certificate', label, ruleId, status: 'skipped', detail: `${ruleId} is disabled in rules ${config.version}.` });
      continue;
    }
    if (!certificate) {
      pending(id, label, ruleId);
      continue;
    }
    const options: ComparisonOptions = {
      minOcrConfidence: rule.minOcrConfidence ?? 0.8,
      minNameSimilarity: rule.minNameSimilarity ?? 0.25,
    };
    const result = compareField(field, app, certificate, options);
    add({
      id,
      group: 'certificate',
      label,
      ruleId,
      status: result.status,
      detail: result.reason,
      declared: result.declared,
      certificate: result.certificate,
    });
  }

  // Declared income against the certificate's.
  {
    const ruleId = 'DECLARED_INCOME_BELOW_CERTIFICATE';
    const rule = ruleConfig(config, ruleId);
    const label = 'Declared income is not below the certificate';
    if (!rule) {
      add({ id: 'certificate.income', group: 'certificate', label, ruleId, status: 'skipped', detail: `${ruleId} is disabled in rules ${config.version}.` });
    } else if (!certificate) {
      pending('certificate.income', label, ruleId);
    } else {
      const read = app.certificateIncome;
      const floor = rule.minOcrConfidence ?? 0.8;
      const fired = declaredIncomeBelowCertificate([app], rule, config.scholarshipIncomeCeiling)[0];
      const shown = { declared: `₹${app.declaredAnnualIncome.toLocaleString('en-IN')}`, certificate: read ? `₹${read.value.toLocaleString('en-IN')}` : null };
      add({
        id: 'certificate.income',
        group: 'certificate',
        label,
        ruleId,
        ...shown,
        ...(fired
          ? { status: 'fail' as const, detail: fired.reason }
          : !read
            ? { status: 'skipped' as const, detail: 'OCR could not read the income figure on the certificate.' }
            : read.confidence < floor
              ? { status: 'skipped' as const, detail: `OCR read the income at ${Math.round(read.confidence * 100)}% confidence, below the ${Math.round(floor * 100)}% needed to rely on it.` }
              : { status: 'pass' as const, detail: 'The declared income is not materially below the certificate. (Declaring more than the certificate is not flagged: it works against the applicant.)' }),
      });
    }
  }

  // Figures against words, on the certificate itself.
  {
    const ruleId = 'CERTIFICATE_INCOME_WORDS_MISMATCH';
    const rule = ruleConfig(config, ruleId);
    const label = 'Income in figures matches income in words';
    if (!rule) {
      add({ id: 'certificate.income_words', group: 'certificate', label, ruleId, status: 'skipped', detail: `${ruleId} is disabled in rules ${config.version}.` });
    } else if (!certificate) {
      pending('certificate.income_words', label, ruleId);
    } else {
      const result = incomeWordsCheck(certificate, { minOcrConfidence: rule.minOcrConfidence ?? 0.8, minNameSimilarity: 0 });
      add({
        id: 'certificate.income_words',
        group: 'certificate',
        label,
        ruleId,
        status: result.status,
        detail: result.reason,
        declared: result.figure,
        certificate: result.words,
      });
    }
  }

  // Forensics.
  {
    const ruleId = 'DOCUMENT_TAMPER_SIGNAL';
    const rule = ruleConfig(config, ruleId);
    const label = 'No sign of editing in the file';
    if (!rule) {
      add({ id: 'document.tamper', group: 'document', label, ruleId, status: 'skipped', detail: `${ruleId} is disabled in rules ${config.version}.` });
    } else if (!certificate || certificate.elaApplied === null) {
      add({
        id: 'document.tamper',
        group: 'document',
        label,
        ruleId,
        status: input.hasDocument ? 'pending' : 'skipped',
        detail: input.hasDocument ? 'Waiting for forensics to analyse the file.' : 'No certificate was uploaded.',
      });
    } else {
      const result = tamperCheck(certificate, rule.minTamperScore ?? 0.5);
      add({ id: 'document.tamper', group: 'document', label, ruleId, status: result.status, detail: result.reason });
    }
  }

  // ------------------------------------------------------ the government record

  {
    const ruleId = 'GOVERNMENT_RECORD_MISMATCH';
    const status = app.verificationStatus ?? null;
    const byStatus: Record<string, { status: CheckStatus; detail: string }> = {
      verified: { status: 'pass', detail: 'A reviewer confirmed this certificate on the state verification portal.' },
      mismatch: { status: 'fail', detail: 'A reviewer recorded that the certificate does not match the government record.' },
      unavailable: {
        status: 'pending',
        detail: 'A reviewer tried the state portal and it was unavailable. Check again and record the result.',
      },
    };
    const outcome = (status && byStatus[status]) || {
      status: 'pending' as const,
      detail: input.manualCheckUrl
        ? 'Waiting for a reviewer to check the certificate on the state portal and record the result.'
        : 'No verification link yet — it is generated when the certificate is processed.',
    };
    add({
      id: 'government.record',
      group: 'government',
      label: 'Certificate matches the government record',
      ruleId,
      status: outcome.status,
      detail: outcome.detail,
    });
  }

  // ------------------------------------------------ against other applications

  for (const { ruleId, label, needs } of HOUSEHOLD_RULES) {
    const id = `household.${ruleId.toLowerCase()}`;
    const flag = flagFor(ruleId);
    if (!ruleConfig(config, ruleId)) {
      add({ id, group: 'household', label, ruleId, status: 'skipped', detail: `${ruleId} is disabled in rules ${config.version}.` });
      continue;
    }
    if (flag) {
      add({ id, group: 'household', label, ruleId, status: 'fail', detail: flag.reason });
      continue;
    }
    if (!input.scored) {
      add({ id, group: 'household', label, ruleId, status: 'pending', detail: 'This application has not been scored yet.' });
      continue;
    }

    const unmet =
      needs === 'household' && input.householdSize < 2
        ? 'Not resolved into a household with any other application, so there is no sibling to compare against.'
        : needs === 'certificateId' && !app.certificateId
          ? 'No certificate number was declared.'
          : needs === 'phone' && !app.normalizedGuardianPhone
            ? 'No usable phone number was declared.'
            : needs === 'issueDate' && !app.certificateIssueDate
              ? 'No certificate issue date was declared.'
              : null;

    add(
      unmet
        ? { id, group: 'household', label, ruleId, status: 'skipped', detail: unmet }
        : {
            id,
            group: 'household',
            label,
            ruleId,
            status: 'pass',
            detail:
              ruleId === 'DEADLINE_PROXIMITY'
                ? 'Not flagged. (This rule only ever reports alongside another signal.)'
                : 'Checked against every application in the cycle; nothing contradicts this one.',
          },
    );
  }

  const summary: Record<CheckStatus, number> = { pass: 0, fail: 0, skipped: 0, pending: 0 };
  for (const check of checks) summary[check.status] += 1;

  return { applicationId: app.id, configVersion: config.version, summary, checks };
}
