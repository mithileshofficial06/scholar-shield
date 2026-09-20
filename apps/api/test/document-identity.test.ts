/**
 * Is the uploaded file an income certificate at all?
 *
 * The gap these cover was found by uploading an unrelated project report to the
 * running app. Every certificate check reported "not checked", the risk score
 * came out 0, and the application sat in the queue looking clean — because each
 * comparison degrades to `skipped` when OCR finds nothing to compare, which is
 * correct behaviour for a bad scan and useless behaviour for the wrong document.
 *
 * The line these tests defend is the one that separates the two: a page read
 * CLEARLY and still missing a certificate's fields is not a certificate. A page
 * read poorly is given the benefit of the doubt, as it always has been.
 */

import { describe, expect, it } from 'vitest';

import {
  documentIdentityCheck,
  type CertificateEvidence,
} from '../src/household/certificate.js';
import { loadRulesConfig } from '../src/household/config.js';
import { documentNotACertificate, type ScorableApplication } from '../src/household/rules.js';

const config = loadRulesConfig();
const rule = config.rules.DOCUMENT_NOT_A_CERTIFICATE!;

const OPTIONS = {
  minPageConfidence: rule.minOcrConfidence ?? 0.8,
  minWordCount: rule.minWordCount ?? 40,
  minIdentifyingFields: rule.minIdentifyingFields ?? 3,
};

function evidence(over: Partial<CertificateEvidence> = {}): CertificateEvidence {
  return {
    fields: {},
    incomeWordsMismatch: null,
    tamperScore: null,
    elaApplied: null,
    softwareTags: [],
    pageConfidence: 0.93,
    wordCount: 800,
    ...over,
  };
}

const field = (value: string) => ({ value, confidence: 0.9 });

/** What a real certificate's extraction looks like. */
const certificateFields = {
  applicant_name: field('Karunanidhi S'),
  guardian_name: field('Selvikarunanidhi'),
  annual_income: field('94500'),
  annual_income_words: field('Ninety Four Thousand Five Hundred'),
  certificate_id: field('TN-CHN-2026-418220'),
  issue_date: field('2026-05-18'),
  issuing_office: field('Tambaram Taluk Office'),
  district: field('Chennai'),
};

describe('documentIdentityCheck', () => {
  it('fails a legible page carrying none of a certificate\'s fields', () => {
    // The original case: a project report. Plenty of text, read confidently,
    // and not one field a certificate has.
    const result = documentIdentityCheck(evidence({ fields: {} }), OPTIONS);

    expect(result.status).toBe('fail');
    expect(result.found).toBe(0);
    expect(result.reason).toContain('is not a certificate read badly');
  });

  it('passes a genuine certificate', () => {
    const result = documentIdentityCheck(evidence({ fields: certificateFields }), OPTIONS);
    expect(result.status).toBe('pass');
    expect(result.found).toBe(8);
  });

  it('passes a certificate where OCR recovered only some fields', () => {
    // Partial recovery is the normal case on a degraded scan. Three is enough
    // to identify the form; the individual comparisons handle the rest.
    const result = documentIdentityCheck(
      evidence({
        fields: {
          applicant_name: certificateFields.applicant_name,
          annual_income: certificateFields.annual_income,
          issuing_office: certificateFields.issuing_office,
        },
      }),
      OPTIONS,
    );
    expect(result.status).toBe('pass');
  });

  it('skips a poorly read page rather than failing it', () => {
    // THE case this must never get wrong. A genuine certificate photographed
    // badly recovers no fields either, and an applicant whose scan came out
    // poorly must not be accused of uploading the wrong document.
    const result = documentIdentityCheck(
      evidence({ fields: {}, pageConfidence: 0.41 }),
      OPTIONS,
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('A poor scan of a real certificate looks exactly like this');
  });

  it('skips a page too sparse to judge', () => {
    const result = documentIdentityCheck(evidence({ fields: {}, wordCount: 6 }), OPTIONS);
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('too little text');
  });

  it('skips when OCR has not run', () => {
    expect(documentIdentityCheck(null, OPTIONS).status).toBe('skipped');
  });

  it('skips when the read reported no confidence or word count', () => {
    const result = documentIdentityCheck(
      evidence({ fields: {}, pageConfidence: null, wordCount: null }),
      OPTIONS,
    );
    expect(result.status).toBe('skipped');
  });

  it('does not count a field OCR returned empty', () => {
    const result = documentIdentityCheck(
      evidence({
        fields: {
          applicant_name: { value: '   ', confidence: 0.9 },
          annual_income: { value: '', confidence: 0.9 },
          district: { value: null, confidence: 0 },
        },
      }),
      OPTIONS,
    );
    expect(result.status).toBe('fail');
    expect(result.found).toBe(0);
  });
});

describe('DOCUMENT_NOT_A_CERTIFICATE', () => {
  function app(over: Partial<ScorableApplication> = {}): ScorableApplication {
    return {
      id: 'app-1',
      cycle: '2026',
      applicantName: 'Karunanidhi S',
      declaredAnnualIncome: 94_500,
      declaredFamilySize: 4,
      normalizedGuardianName: 'selvikarunanidhi',
      normalizedAddress: '29b kmk strit udayampalayam coimbatore',
      normalizedGuardianPhone: '6380409380',
      issuingOffice: 'Tambaram Taluk Office',
      certificateIssueDate: '2026-05-18',
      certificateId: 'TN-CHN-2026-418220',
      ...over,
    };
  }

  it('flags an application whose upload is some other document', () => {
    const findings = documentNotACertificate([app({ certificate: evidence() })], rule);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('DOCUMENT_NOT_A_CERTIFICATE');
    expect(findings[0]!.evidence.identifyingFieldsFound).toBe(0);
  });

  it('leaves a genuine certificate alone', () => {
    const findings = documentNotACertificate(
      [app({ certificate: evidence({ fields: certificateFields }) })],
      rule,
    );
    expect(findings).toEqual([]);
  });

  it('leaves an application with no document alone', () => {
    // A missing certificate is already its own check on the reviewer's
    // checklist. This rule must not double-count it.
    expect(documentNotACertificate([app({ certificate: null })], rule)).toEqual([]);
  });

  it('is silent when disabled', () => {
    const findings = documentNotACertificate([app({ certificate: evidence() })], {
      ...rule,
      enabled: false,
    });
    expect(findings).toEqual([]);
  });
});
