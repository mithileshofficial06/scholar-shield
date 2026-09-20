import { describe, expect, it } from 'vitest';

import {
  compareField,
  editingSoftwareCheck,
  elaCheck,
  incomeWordsCheck,
  type CertificateEvidence,
} from '../src/household/certificate.js';
import { buildChecklist, type ChecklistInput } from '../src/household/checklist.js';
import { detectComponents } from '../src/household/components.js';
import { ACTIVE_RULES_VERSION, loadRulesConfig } from '../src/household/config.js';
import { evaluateRules, POPULATION_RULES, type ScorableApplication } from '../src/household/rules.js';

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
  // Pinned to v3 explicitly. These assertions are about what v3 *is*; reading
  // the active version here would turn a published config into a moving target
  // and quietly stop testing the thing it names.
  const v3 = loadRulesConfig('v3');

  it('carries every v2 rule unchanged and adds exactly the six certificate checks', () => {
    const v2 = loadRulesConfig('v2');
    for (const [id, rule] of Object.entries(v2.rules)) expect(v3.rules[id]).toEqual(rule);
    expect(Object.keys(v3.rules).filter((id) => !(id in v2.rules)).sort()).toEqual([
      'CERTIFICATE_DETAILS_MISMATCH',
      'CERTIFICATE_HOLDER_MISMATCH',
      'CERTIFICATE_INCOME_WORDS_MISMATCH',
      'CERTIFICATE_NUMBER_MISMATCH',
      'DOCUMENT_TAMPER_SIGNAL',
      'GOVERNMENT_RECORD_MISMATCH',
    ]);
  });

  it('keeps the tamper signal below the high-severity band on its own', () => {
    expect(v3.rules.DOCUMENT_TAMPER_SIGNAL!.weight).toBeLessThan(v3.highSeverityScoreThreshold);
  });
});

describe('rule config v4', () => {
  const v3 = loadRulesConfig('v3');
  const v4 = loadRulesConfig('v4');

  it('carries every v3 rule unchanged and adds exactly the four population rules', () => {
    for (const [id, rule] of Object.entries(v3.rules)) expect(v4.rules[id]).toEqual(rule);
    expect(Object.keys(v4.rules).filter((id) => !(id in v3.rules)).sort()).toEqual([
      'CERTIFICATE_SERIAL_ADJACENCY',
      'HOUSEHOLD_FRAGMENTATION',
      'IDENTICAL_ROUND_INCOME_CLUSTER',
      'INCOME_THRESHOLD_BUNCHING',
    ]);
  });

  // The promise Tier 1b makes. A population signal describes company an
  // applicant keeps rather than anything they did, so no one of them may be
  // able to carry an application into the high-severity band by itself. If a
  // later version raises a weight past this line, that is a decision someone
  // should have to make deliberately, not a number that drifted.
  it('keeps every population rule below the high-severity band on its own', () => {
    for (const ruleId of POPULATION_RULES) {
      expect(v4.rules[ruleId]!.weight).toBeLessThan(v4.highSeverityScoreThreshold);
    }
  });

  it('is the version the engine scores under', () => {
    expect(ACTIVE_RULES_VERSION).toBe('v4');
    expect(config.version).toBe('v4');
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

  // Cases found in the seeded data, each once a false flag on an honest certificate.
  it('matches a name carrying the same initial on both sides', () => {
    const initial = app({ guardianName: 'V. Ramachandran' });
    expect(compareField('guardian_name', initial, evidence({}, { guardian_name: read('V. Ramachandran') })).status).toBe('pass');
  });

  it('tolerates an OCR misread in a district name', () => {
    const misread = app({ district: 'Madurai' });
    expect(compareField('district', misread, evidence({}, { district: read('Maduraj') })).status).toBe('pass');
    expect(compareField('district', misread, evidence({}, { district: read('Coimbatore') })).status).toBe('fail');
  });

  it('compares a PIN by postal sorting district, not by post office', () => {
    const pin = app({ pincode: '620001' });
    expect(compareField('pincode', pin, evidence({}, { pincode: read('620004') })).status).toBe('pass');
    expect(compareField('pincode', pin, evidence({}, { pincode: read('641012') })).status).toBe('fail');
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
  it('flags an editor named in the metadata', () => {
    const photoshopped = app({ certificate: evidence({ softwareTags: ['Adobe Photoshop 25.0'] }) });
    expect(fired([photoshopped])).toContain('DOCUMENT_TAMPER_SIGNAL');
    expect(editingSoftwareCheck(photoshopped.certificate).editors).toEqual(['Adobe Photoshop 25.0']);
  });

  it('does not treat a PDF writer applicants routinely use as an editor', () => {
    expect(editingSoftwareCheck(evidence({ softwareTags: ['Adobe Acrobat Pro', 'iLovePDF'] })).status).toBe('pass');
  });

  it('does not score ELA in v3, however high — it measured at chance on the corpus', () => {
    expect(config.rules.DOCUMENT_TAMPER_SIGNAL!.minTamperScore).toBeUndefined();
    expect(fired([app({ certificate: evidence({ tamperScore: 1 }) })])).not.toContain('DOCUMENT_TAMPER_SIGNAL');
    expect(elaCheck(evidence({ tamperScore: 1 }), null).status).toBe('skipped');
  });

  it('scores ELA against a threshold when a config sets one', () => {
    expect(elaCheck(evidence({ tamperScore: 0.7 }), 0.5).status).toBe('fail');
    expect(elaCheck(evidence({ tamperScore: 0.3 }), 0.5).status).toBe('pass');
  });

  it('reports "not measured" rather than "clean" when ELA could not run', () => {
    expect(elaCheck(evidence({ elaApplied: false, tamperScore: 0 }), 0.5).status).toBe('skipped');
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
    expect(statusOf(list, 'document.metadata')).toBe('pass');
    expect(statusOf(list, 'document.ela')).toBe('skipped');
  });

  it('never disagrees with the flags about the same application', () => {
    const cases = [
      app(),
      app({ certificate: evidence({ softwareTags: ['GIMP 2.10'], incomeWordsMismatch: true }, { applicant_name: read('Someone Else') }) }),
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
    for (const id of ['certificate.applicant_name', 'certificate.income', 'document.metadata', 'document.ela']) {
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
