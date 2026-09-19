import { describe, expect, it } from 'vitest';

import {
  compareField,
  incomeWordsCheck,
  tamperCheck,
  type CertificateEvidence,
} from '../src/household/certificate.js';
import { buildChecklist, type ChecklistInput } from '../src/household/checklist.js';
import { detectComponents } from '../src/household/components.js';
import { loadRulesConfig } from '../src/household/config.js';
import { evaluateRules, type ScorableApplication } from '../src/household/rules.js';

const config = loadRulesConfig();
const DEADLINE = '2026-07-31';

const read = (value: string, confidence = 0.93) => ({ value, confidence });

/** A certificate that agrees with `app()` below in every particular. */
function evidence(over: Partial<CertificateEvidence> = {}, fields: CertificateEvidence['fields'] = {}): CertificateEvidence {
  return {
    fields: {
      applicant_name: read('Kavya Velmurugan'),
      guardian_name: read('Ramasamy Velmurugan'),
      certificate_id: read('TN-CBE-2026-418201'),
      district: read('Coimbatore'),
      pincode: read('641012'),
      family_size: read('4'),
      annual_income: read('Rs. 1,80,000/'),
      annual_income_words: read('One Lakh Eighty Thousand Rupees Only'),
      ...fields,
    },
    incomeWordsMismatch: false,
    tamperScore: 0.06,
    elaApplied: true,
    softwareTags: [],
    ...over,
  };
}

function app(over: Partial<ScorableApplication> = {}): ScorableApplication {
  const certificate = over.certificate === undefined ? evidence() : over.certificate;
  return {
    id: 'a',
    cycle: '2026',
    applicantName: 'Kavya Velmurugan',
    guardianName: 'Ramasamy Velmurugan',
    district: 'Coimbatore',
    pincode: '641012',
    declaredAnnualIncome: 180_000,
    declaredFamilySize: 4,
    normalizedGuardianName: 'ramasami velmurugan',
    normalizedAddress: '14 periyar strit gandipuram coimbatore',
    normalizedGuardianPhone: '9876501234',
    issuingOffice: 'Taluk Office Coimbatore North',
    certificateIssueDate: '2026-05-10',
    certificateId: 'TN-CBE-2026-418201',
    certificateIncome: certificate ? { value: 180_000, confidence: 0.93 } : null,
    verificationStatus: 'manual_check_required',
    ...over,
    certificate,
  };
}

const evaluate = (apps: ScorableApplication[]) =>
  evaluateRules(apps, detectComponents(apps.map((a) => a.id), []), config, DEADLINE);
const fired = (apps: ScorableApplication[], id = 'a') =>
  evaluate(apps).findings.filter((f) => f.applicationId === id).map((f) => f.ruleId);

describe('rule config v3', () => {
  it('carries every v2 rule unchanged and adds exactly the six certificate checks', () => {
    const v2 = loadRulesConfig('v2');
    for (const [id, rule] of Object.entries(v2.rules)) expect(config.rules[id]).toEqual(rule);
    expect(Object.keys(config.rules).filter((id) => !(id in v2.rules)).sort()).toEqual([
      'CERTIFICATE_DETAILS_MISMATCH',
      'CERTIFICATE_HOLDER_MISMATCH',
      'CERTIFICATE_INCOME_WORDS_MISMATCH',
      'CERTIFICATE_NUMBER_MISMATCH',
      'DOCUMENT_TAMPER_SIGNAL',
      'GOVERNMENT_RECORD_MISMATCH',
    ]);
  });

  it('keeps the tamper signal below the high-severity band on its own', () => {
    expect(config.rules.DOCUMENT_TAMPER_SIGNAL!.weight).toBeLessThan(config.highSeverityScoreThreshold);
  });
});

describe('certificate against the form', () => {
  it('passes an honest application on every comparison', () => {
    expect(fired([app()])).toEqual([]);
  });

  // The measured pairs behind minNameSimilarity. If a change to the name
  // matcher moves one of these across the line, this is where it shows.
  const samePerson = [
    ['Ramaswamy Velmurugan', 'Ramasamy Velmurugan'],
    ['Mohammed Ismail', 'Muhammad Ismail'],
    ['Kavya Velmurugan', 'Kaviya Velmurgan'],
    ['Priya Ramesh', 'Priya Rarnesh'], // OCR read "m" as "rn"
    ['Senthil Kumar', 'Sendil Kumar'],
    ['Lakshmi Narayanan', 'Laxmi Narayanan'],
  ];
  const differentPeople = [
    ['Kavya Velmurugan', 'Arun Velmurugan'],
    ['Divya Senthil', 'Kavya Senthil'],
    ['Karthik Ramesh', 'Kavya Ramesh'],
    ['Priya Ramesh', 'Divya Ramesh'],
  ];

  it.each(samePerson)('accepts %s on the form as %s on the certificate', (declared, onCertificate) => {
    const result = compareField('applicant_name', app({ applicantName: declared }), evidence({}, { applicant_name: read(onCertificate!) }));
    expect(result.status).toBe('pass');
  });

  it.each(differentPeople)('rejects %s on the form against %s on the certificate', (declared, onCertificate) => {
    const result = compareField('applicant_name', app({ applicantName: declared }), evidence({}, { applicant_name: read(onCertificate!) }));
    expect(result.status).toBe('fail');
  });

  it("flags a certificate issued to someone else — a sibling's, say", () => {
    const sibling = app({ certificate: evidence({}, { applicant_name: read('Arun Velmurugan') }) });
    expect(fired([sibling])).toContain('CERTIFICATE_HOLDER_MISMATCH');
  });

  it('flags a certificate whose number is not the one given', () => {
    const other = app({ certificate: evidence({}, { certificate_id: read('TN-CBE-2026-999999') }) });
    expect(fired([other])).toContain('CERTIFICATE_NUMBER_MISMATCH');
  });

  it('ignores formatting in a certificate number', () => {
    expect(compareField('certificate_id', app({ certificateId: 'tn cbe 2026 418201' }), evidence()).status).toBe('pass');
  });

  it('flags a different district, PIN or family size at medium severity', () => {
    const moved = app({ certificate: evidence({}, { family_size: read('6') }) });
    const finding = evaluate([moved]).findings.find((f) => f.ruleId === 'CERTIFICATE_DETAILS_MISMATCH');
    expect(finding?.severity).toBe('medium');
    expect(finding?.reason).toContain('Family size');
  });

  it('skips, never fails, a field OCR was unsure of', () => {
    const blurred = app({ certificate: evidence({}, { applicant_name: read('Arun Velmurugan', 0.4) }) });
    expect(compareField('applicant_name', blurred, blurred.certificate).status).toBe('skipped');
    expect(fired([blurred])).not.toContain('CERTIFICATE_HOLDER_MISMATCH');
  });

  it('skips a field the applicant did not declare', () => {
    expect(compareField('pincode', app({ pincode: null }), evidence()).status).toBe('skipped');
  });
});

describe('income in figures against words', () => {
  it('flags a certificate whose two income lines disagree', () => {
    const edited = app({ certificate: evidence({ incomeWordsMismatch: true }, { annual_income: read('Rs. 80,000/') }) });
    expect(fired([edited])).toContain('CERTIFICATE_INCOME_WORDS_MISMATCH');
  });

  it('cannot compare when either line was unreadable', () => {
    expect(incomeWordsCheck(evidence({ incomeWordsMismatch: null })).status).toBe('skipped');
  });
});

describe('tamper signal', () => {
  it('flags an anomalous region at or above the threshold', () => {
    expect(fired([app({ certificate: evidence({ tamperScore: 0.7 }) })])).toContain('DOCUMENT_TAMPER_SIGNAL');
  });

  it('flags an editor named in the metadata even with a clean ELA score', () => {
    const check = tamperCheck(evidence({ softwareTags: ['Adobe Photoshop 25.0'] }), 0.5);
    expect(check.status).toBe('fail');
    expect(check.editors).toEqual(['Adobe Photoshop 25.0']);
  });

  it('does not treat a PDF writer applicants routinely use as an editor', () => {
    expect(tamperCheck(evidence({ softwareTags: ['Adobe Acrobat Pro', 'iLovePDF'] }), 0.5).status).toBe('pass');
  });

  it('reports "not measured" rather than "clean" when ELA could not run', () => {
    expect(tamperCheck(evidence({ elaApplied: false, tamperScore: 0 }), 0.5).status).toBe('skipped');
  });
});

describe('government record', () => {
  it('weighs a reviewer-recorded mismatch highest of all', () => {
    const result = evaluate([app({ verificationStatus: 'mismatch' })]);
    expect(result.findings.map((f) => f.ruleId)).toEqual(['GOVERNMENT_RECORD_MISMATCH']);
    expect(result.scores.get('a')).toBe(config.rules.GOVERNMENT_RECORD_MISMATCH!.weight);
  });
});

// ------------------------------------------------------------------ checklist

function checklistFor(application: ScorableApplication, over: Partial<ChecklistInput> = {}) {
  const findings = evaluate([application]).findings;
  return buildChecklist({
    application,
    hasDocument: application.certificate !== null,
    pageConfidence: 0.91,
    stages: ['ocr_extract', 'forensics_analyze', 'verification_check', 'household_reconcile', 'risk_score'].map(
      (stage) => ({ stage, status: 'succeeded' as const, lastError: null }),
    ),
    flags: findings.map((f) => ({ ruleId: f.ruleId, ruleConfigVersion: config.version, severity: f.severity, reason: f.reason })),
    householdSize: 1,
    scored: true,
    manualCheckUrl: 'https://portal.example/verify?certificateNo=X',
    config,
    ...over,
  });
}

const statusOf = (list: ReturnType<typeof checklistFor>, id: string) => list.checks.find((c) => c.id === id)?.status;

describe('reviewer checklist', () => {
  it('lists every check, not only the ones that failed', () => {
    const list = checklistFor(app());
    expect(list.summary.fail).toBe(0);
    expect(list.checks.length).toBeGreaterThanOrEqual(20);
    expect(statusOf(list, 'certificate.applicant_name')).toBe('pass');
    expect(statusOf(list, 'document.tamper')).toBe('pass');
  });

  it('never disagrees with the flags about the same application', () => {
    const cases = [
      app(),
      app({ certificate: evidence({ tamperScore: 0.9, incomeWordsMismatch: true }, { applicant_name: read('Someone Else') }) }),
      app({ declaredAnnualIncome: 90_000, certificateIncome: { value: 480_000, confidence: 0.93 } }),
      app({ verificationStatus: 'mismatch' }),
    ];
    for (const application of cases) {
      // Per rule, not per check: one rule can own several checks (the holder
      // rule owns both names), so a passing guardian name beside a failing
      // applicant name is consistent. What must hold is that a rule fired
      // exactly when at least one of its checks failed.
      const flagged = new Set(evaluate([application]).findings.map((f) => f.ruleId));
      const list = checklistFor(application);
      const ruleIds = new Set(list.checks.map((c) => c.ruleId).filter((id): id is string => id !== null));
      for (const ruleId of ruleIds) {
        const anyFailed = list.checks.some((c) => c.ruleId === ruleId && c.status === 'fail');
        expect(anyFailed, ruleId).toBe(flagged.has(ruleId));
      }
    }
  });

  it('shows both sides of a failed comparison', () => {
    const list = checklistFor(app({ certificate: evidence({}, { certificate_id: read('TN-CBE-2026-999999') }) }));
    const check = list.checks.find((c) => c.id === 'certificate.certificate_id')!;
    expect(check).toMatchObject({ status: 'fail', declared: 'TN-CBE-2026-418201', certificate: 'TN-CBE-2026-999999' });
  });

  it('marks every document check skipped when no certificate was uploaded', () => {
    const list = checklistFor(app({ certificate: null }), { stages: [] });
    expect(statusOf(list, 'document.uploaded')).toBe('fail');
    for (const id of ['certificate.applicant_name', 'certificate.income', 'document.tamper']) {
      expect(statusOf(list, id)).toBe('skipped');
    }
  });

  it('shows checks as pending while the pipeline is still running', () => {
    const list = checklistFor(app({ certificate: null }), { hasDocument: true, stages: [], scored: false });
    expect(statusOf(list, 'document.processed')).toBe('pending');
    expect(statusOf(list, 'certificate.applicant_name')).toBe('pending');
    expect(statusOf(list, 'household.sibling_income_contradiction')).toBe('pending');
  });

  it('reports a dead-lettered document as a failure with its stage and error', () => {
    const list = checklistFor(app(), {
      stages: [{ stage: 'ocr_extract', status: 'dead_lettered', lastError: 'OCR service answered 415' }],
    });
    const check = list.checks.find((c) => c.id === 'document.processed')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('ocr_extract');
  });

  it('waits on a reviewer for the government record, and records their answer', () => {
    expect(statusOf(checklistFor(app()), 'government.record')).toBe('pending');
    expect(statusOf(checklistFor(app({ verificationStatus: 'verified' })), 'government.record')).toBe('pass');
    expect(statusOf(checklistFor(app({ verificationStatus: 'mismatch' })), 'government.record')).toBe('fail');
  });

  it('explains why a household check could not run for a lone applicant', () => {
    const check = checklistFor(app()).checks.find((c) => c.id === 'household.sibling_income_contradiction')!;
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('household');
  });

  it('counts every status in the summary', () => {
    const list = checklistFor(app());
    const total = Object.values(list.summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(list.checks.length);
  });
});
