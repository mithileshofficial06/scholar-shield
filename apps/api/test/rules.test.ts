import { describe, expect, it } from 'vitest';
import { ACTIVE_RULES_VERSION, loadRulesConfig } from '../src/household/config.js';
import { detectComponents } from '../src/household/components.js';
import { evaluateRules, type ScorableApplication } from '../src/household/rules.js';
import type { PairResolution, ResolvedEdge } from '../src/household/resolve.js';

const config = loadRulesConfig();
const DEADLINE = '2026-07-31';

function app(id: string, over: Partial<ScorableApplication> = {}): ScorableApplication {
  return {
    id,
    cycle: '2026',
    applicantName: `Applicant ${id}`,
    declaredAnnualIncome: 90_000,
    declaredFamilySize: 4,
    normalizedGuardianName: 'raman subramaniam',
    normalizedAddress: '14 barati strit ayanavaram cenai',
    normalizedGuardianPhone: null,
    issuingOffice: 'Ayanavaram Taluk Office',
    certificateIssueDate: '2026-05-10',
    certificateId: `CERT-${id}`,
    ...over,
  };
}

function link(a: string, b: string): PairResolution {
  const edge: ResolvedEdge = {
    applicationAId: a,
    applicationBId: b,
    matchField: 'guardian_name',
    similarity: 0.95,
    weight: 0.5,
  };
  return { applicationAId: a, applicationBId: b, edges: [edge], score: 0.9, linked: true };
}

function evaluate(apps: ScorableApplication[], pairs: PairResolution[] = []) {
  const components = detectComponents(
    apps.map((a) => a.id),
    pairs,
  );
  return evaluateRules(apps, components, config, DEADLINE);
}

const rulesFiredFor = (result: ReturnType<typeof evaluate>, id: string) =>
  result.findings.filter((f) => f.applicationId === id).map((f) => f.ruleId);

describe('rule config', () => {
  it('loads the active version and declares a matching version', () => {
    expect(config.version).toBe(ACTIVE_RULES_VERSION);
    expect(config.rules.SIBLING_INCOME_CONTRADICTION?.enabled).toBe(true);
  });

  it('keeps v1 loadable, so a v1-stamped score stays reproducible', () => {
    expect(loadRulesConfig('v1').version).toBe('v1');
  });

  it('v2 only adds a rule — every v1 rule is carried over unchanged', () => {
    const v1 = loadRulesConfig('v1');
    const v2 = loadRulesConfig('v2');
    for (const [id, rule] of Object.entries(v1.rules)) expect(v2.rules[id]).toEqual(rule);
    expect(Object.keys(v2.rules).filter((id) => !(id in v1.rules))).toEqual([
      'DECLARED_INCOME_BELOW_CERTIFICATE',
    ]);
  });

  it('refuses a version that does not exist', () => {
    expect(() => loadRulesConfig('v99')).toThrow();
  });
});

describe('SIBLING_INCOME_CONTRADICTION', () => {
  it('flags both sides of a material income disagreement in one household', () => {
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 96_000 }), app('b', { declaredAnnualIncome: 178_000 })],
      [link('a', 'b')],
    );

    expect(rulesFiredFor(result, 'a')).toContain('SIBLING_INCOME_CONTRADICTION');
    // Neither application is presumptively the honest one.
    expect(rulesFiredFor(result, 'b')).toContain('SIBLING_INCOME_CONTRADICTION');
  });

  it('does not fire on small variation between two low incomes', () => {
    // ₹84,000 vs ₹79,000 — 6%. Two certificates issued months apart genuinely
    // differ this much.
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 84_000 }), app('b', { declaredAnnualIncome: 79_000 })],
      [link('a', 'b')],
    );
    expect(result.findings).toEqual([]);
  });

  it('requires the absolute tolerance too, not just the percentage', () => {
    // ₹24,000 vs ₹20,000 is 17% — over the percentage — but only ₹4,000 apart.
    // Flagging this targets exactly the applicants least able to contest it.
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 24_000 }), app('b', { declaredAnnualIncome: 20_000 })],
      [link('a', 'b')],
    );
    expect(rulesFiredFor(result, 'a')).not.toContain('SIBLING_INCOME_CONTRADICTION');
  });

  it('does not fire across unlinked households', () => {
    const result = evaluate([
      app('a', { declaredAnnualIncome: 96_000, normalizedGuardianName: 'raman subramaniam' }),
      app('b', { declaredAnnualIncome: 178_000, normalizedGuardianName: 'kannan velusami' }),
    ]);
    expect(rulesFiredFor(result, 'a')).not.toContain('SIBLING_INCOME_CONTRADICTION');
  });

  it('names the other applicant and both figures in the reason', () => {
    const result = evaluate(
      [
        app('a', { applicantName: 'Hariharan', declaredAnnualIncome: 96_000 }),
        app('b', { applicantName: 'Gowri', declaredAnnualIncome: 178_000 }),
      ],
      [link('a', 'b')],
    );

    const finding = result.findings.find(
      (f) => f.applicationId === 'a' && f.ruleId === 'SIBLING_INCOME_CONTRADICTION',
    )!;

    expect(finding.reason).toContain('Gowri');
    expect(finding.reason).toContain('96,000');
    expect(finding.reason).toContain('1,78,000');
    expect(finding.evidence.otherApplicationId).toBe('b');
  });
});

describe('GUARDIAN_INCOME_CONTRADICTION', () => {
  it('fires when one guardian appears across separate households', () => {
    const result = evaluate([
      app('a', { declaredAnnualIncome: 89_000, normalizedAddress: 'addr one' }),
      app('b', { declaredAnnualIncome: 640_000, normalizedAddress: 'addr two' }),
    ]);

    expect(rulesFiredFor(result, 'a')).toContain('GUARDIAN_INCOME_CONTRADICTION');
  });

  it('does not double-count within a single household', () => {
    // SIBLING already covers same-household pairs; counting both inflates score.
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 89_000 }), app('b', { declaredAnnualIncome: 640_000 })],
      [link('a', 'b')],
    );

    expect(rulesFiredFor(result, 'a')).toContain('SIBLING_INCOME_CONTRADICTION');
    expect(rulesFiredFor(result, 'a')).not.toContain('GUARDIAN_INCOME_CONTRADICTION');
  });

  it('ignores applications with no guardian name recorded', () => {
    const result = evaluate([
      app('a', { normalizedGuardianName: '', declaredAnnualIncome: 89_000 }),
      app('b', { normalizedGuardianName: '', declaredAnnualIncome: 640_000 }),
    ]);
    expect(result.findings).toEqual([]);
  });
});

describe('ADDRESS_CLUSTER_UNRELATED', () => {
  const atAddress = (id: string, guardian: string) =>
    app(id, {
      normalizedGuardianName: guardian,
      normalizedAddress: 'shared tenement address',
      declaredAnnualIncome: 76_000,
    });

  it('fires once three separate households share an address below the ceiling', () => {
    const result = evaluate([
      atAddress('a', 'sankar duraisami'),
      atAddress('b', 'sekar ponusami'),
      atAddress('c', 'kanan velusami'),
    ]);

    expect(rulesFiredFor(result, 'a')).toContain('ADDRESS_CLUSTER_UNRELATED');
  });

  it('does not fire below the household threshold', () => {
    const result = evaluate([atAddress('a', 'sankar duraisami'), atAddress('b', 'sekar ponusami')]);
    expect(result.findings).toEqual([]);
  });

  it('ignores applicants above the eligibility ceiling', () => {
    const rich = (id: string, guardian: string) =>
      app(id, {
        normalizedGuardianName: guardian,
        normalizedAddress: 'shared tenement address',
        declaredAnnualIncome: 900_000,
      });

    const result = evaluate([rich('a', 'g one'), rich('b', 'g two'), rich('c', 'g three')]);
    expect(rulesFiredFor(result, 'a')).not.toContain('ADDRESS_CLUSTER_UNRELATED');
  });

  it('is medium severity, not high — shared housing is common and legitimate', () => {
    const result = evaluate([
      atAddress('a', 'sankar duraisami'),
      atAddress('b', 'sekar ponusami'),
      atAddress('c', 'kanan velusami'),
    ]);

    const finding = result.findings.find((f) => f.ruleId === 'ADDRESS_CLUSTER_UNRELATED')!;
    expect(finding.severity).toBe('medium');
    expect(finding.reason).toContain('not a finding against the applicant');
  });
});

describe('ISSUING_OFFICE_MISMATCH', () => {
  it('fires when one household used two offices', () => {
    const result = evaluate(
      [app('a', { issuingOffice: 'Ayanavaram Taluk Office' }), app('b', { issuingOffice: 'Perambur Taluk Office' })],
      [link('a', 'b')],
    );
    expect(rulesFiredFor(result, 'a')).toContain('ISSUING_OFFICE_MISMATCH');
  });

  it('does not fire when the offices agree', () => {
    const result = evaluate([app('a'), app('b')], [link('a', 'b')]);
    expect(rulesFiredFor(result, 'a')).not.toContain('ISSUING_OFFICE_MISMATCH');
  });

  it('is low weight — a family that moved uses two offices legitimately', () => {
    expect(config.rules.ISSUING_OFFICE_MISMATCH!.severity).toBe('low');
    expect(config.rules.ISSUING_OFFICE_MISMATCH!.weight).toBeLessThan(
      config.rules.SIBLING_INCOME_CONTRADICTION!.weight,
    );
  });
});

describe('DUPLICATE_CERTIFICATE_ID', () => {
  it('fires on both applications sharing one certificate serial number', () => {
    const result = evaluate([
      app('a', { certificateId: 'TN-CBE-2026-660214' }),
      app('b', { certificateId: 'TN-CBE-2026-660214' }),
    ]);

    expect(rulesFiredFor(result, 'a')).toContain('DUPLICATE_CERTIFICATE_ID');
    expect(rulesFiredFor(result, 'b')).toContain('DUPLICATE_CERTIFICATE_ID');
  });

  it('does not fire when certificate ids differ', () => {
    const result = evaluate([app('a', { certificateId: 'TN-CBE-2026-1' }), app('b', { certificateId: 'TN-CBE-2026-2' })]);
    expect(result.findings).toEqual([]);
  });

  it('ignores applications with no certificate id recorded', () => {
    const result = evaluate([app('a', { certificateId: null }), app('b', { certificateId: null })]);
    expect(result.findings).toEqual([]);
  });

  it('needs no tolerance — exact match alone is enough, at high severity', () => {
    const result = evaluate([
      app('a', { certificateId: 'TN-CBE-2026-660214' }),
      app('b', { certificateId: 'TN-CBE-2026-660214' }),
    ]);
    const finding = result.findings.find((f) => f.ruleId === 'DUPLICATE_CERTIFICATE_ID')!;
    expect(finding.severity).toBe('high');
  });
});

describe('FAMILY_SIZE_CONTRADICTION', () => {
  it('fires when one household disagrees on family size', () => {
    const result = evaluate(
      [app('a', { declaredFamilySize: 3 }), app('b', { declaredFamilySize: 7 })],
      [link('a', 'b')],
    );

    expect(rulesFiredFor(result, 'a')).toContain('FAMILY_SIZE_CONTRADICTION');
    expect(rulesFiredFor(result, 'b')).toContain('FAMILY_SIZE_CONTRADICTION');
  });

  it('does not fire when the household agrees on family size', () => {
    const result = evaluate(
      [app('a', { declaredFamilySize: 4 }), app('b', { declaredFamilySize: 4 })],
      [link('a', 'b')],
    );
    expect(result.findings).toEqual([]);
  });

  it('does not fire across unlinked households', () => {
    const result = evaluate([app('a', { declaredFamilySize: 3 }), app('b', { declaredFamilySize: 7 })]);
    expect(result.findings).toEqual([]);
  });

  it('is medium severity — family size genuinely changes over time', () => {
    const result = evaluate(
      [app('a', { declaredFamilySize: 3 }), app('b', { declaredFamilySize: 7 })],
      [link('a', 'b')],
    );
    const finding = result.findings.find((f) => f.ruleId === 'FAMILY_SIZE_CONTRADICTION')!;
    expect(finding.severity).toBe('medium');
  });
});

describe('SHARED_CONTACT_UNRELATED_HOUSEHOLDS', () => {
  it('fires when the same contact number spans two unlinked households', () => {
    const result = evaluate([
      app('a', { normalizedGuardianPhone: '9840112233' }),
      app('b', { normalizedGuardianPhone: '9840112233' }),
    ]);

    expect(rulesFiredFor(result, 'a')).toContain('SHARED_CONTACT_UNRELATED_HOUSEHOLDS');
    expect(rulesFiredFor(result, 'b')).toContain('SHARED_CONTACT_UNRELATED_HOUSEHOLDS');
  });

  it('does not fire within a single household — one family, one number', () => {
    const result = evaluate(
      [app('a', { normalizedGuardianPhone: '9840112233' }), app('b', { normalizedGuardianPhone: '9840112233' })],
      [link('a', 'b')],
    );
    expect(rulesFiredFor(result, 'a')).not.toContain('SHARED_CONTACT_UNRELATED_HOUSEHOLDS');
  });

  it('ignores applications with no phone recorded', () => {
    const result = evaluate([app('a', { normalizedGuardianPhone: null }), app('b', { normalizedGuardianPhone: null })]);
    expect(result.findings).toEqual([]);
  });

  it('does not fire when numbers differ', () => {
    const result = evaluate([
      app('a', { normalizedGuardianPhone: '9840112233' }),
      app('b', { normalizedGuardianPhone: '9111000022' }),
    ]);
    expect(result.findings).toEqual([]);
  });
});

describe('DEADLINE_PROXIMITY — never fires alone', () => {
  const lastMinute = { certificateIssueDate: '2026-07-25' };

  it('does not fire on an application carrying no other finding', () => {
    // Siblings in one admission cycle obtain certificates days apart. That is
    // normal and evidence of nothing.
    const result = evaluate([app('a', lastMinute), app('b', lastMinute)]);
    expect(result.findings).toEqual([]);
  });

  it('fires once another rule has already flagged the application', () => {
    const result = evaluate(
      [
        app('a', { ...lastMinute, declaredAnnualIncome: 96_000 }),
        app('b', { ...lastMinute, declaredAnnualIncome: 178_000 }),
      ],
      [link('a', 'b')],
    );

    expect(rulesFiredFor(result, 'a')).toContain('DEADLINE_PROXIMITY');
  });

  it('ignores certificates issued well before the deadline', () => {
    const result = evaluate(
      [
        app('a', { certificateIssueDate: '2026-01-10', declaredAnnualIncome: 96_000 }),
        app('b', { certificateIssueDate: '2026-01-12', declaredAnnualIncome: 178_000 }),
      ],
      [link('a', 'b')],
    );
    expect(rulesFiredFor(result, 'a')).not.toContain('DEADLINE_PROXIMITY');
  });

  it('ignores a missing or unparseable issue date', () => {
    const result = evaluate(
      [
        app('a', { certificateIssueDate: null, declaredAnnualIncome: 96_000 }),
        app('b', { certificateIssueDate: null, declaredAnnualIncome: 178_000 }),
      ],
      [link('a', 'b')],
    );
    expect(rulesFiredFor(result, 'a')).not.toContain('DEADLINE_PROXIMITY');
  });
});

describe('scoring', () => {
  it('sums weights per application and stamps the config version', () => {
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 96_000 }), app('b', { declaredAnnualIncome: 178_000 })],
      [link('a', 'b')],
    );

    expect(result.configVersion).toBe(ACTIVE_RULES_VERSION);
    expect(result.scores.get('a')).toBe(config.rules.SIBLING_INCOME_CONTRADICTION!.weight);
  });

  it('gives every application a score, including clean ones', () => {
    const result = evaluate([app('a'), app('b', { normalizedGuardianName: 'other guardian' })]);
    expect(result.scores.get('a')).toBe(0);
    expect(result.scores.get('b')).toBe(0);
  });

  it('produces no findings at all for a clean single application', () => {
    expect(evaluate([app('solo')]).findings).toEqual([]);
  });

  it('gives every finding a reason and an evidence payload', () => {
    const result = evaluate(
      [app('a', { declaredAnnualIncome: 96_000 }), app('b', { declaredAnnualIncome: 178_000 })],
      [link('a', 'b')],
    );

    for (const finding of result.findings) {
      expect(finding.reason.length).toBeGreaterThan(20);
      expect(Object.keys(finding.evidence).length).toBeGreaterThan(0);
    }
  });
});

describe('DECLARED_INCOME_BELOW_CERTIFICATE', () => {
  const read = (value: number, confidence = 0.92) => ({ certificateIncome: { value, confidence } });

  it('fires on a lone applicant whose certificate shows more than they declared', () => {
    const result = evaluate([app('a', { declaredAnnualIncome: 120_000, ...read(480_000) })]);
    const finding = result.findings.find((f) => f.ruleId === 'DECLARED_INCOME_BELOW_CERTIFICATE');

    expect(finding?.applicationId).toBe('a');
    expect(finding?.severity).toBe('high');
    expect(finding?.evidence).toMatchObject({ declaredIncome: 120_000, certificateIncome: 480_000, crossesCeiling: true });
    expect(finding?.reason).toContain('eligibility ceiling');
  });

  it('separates the understating sibling from the honest one', () => {
    // The case end-to-end testing surfaced: both siblings carried the same
    // household contradiction and the same score, though only one lied.
    const result = evaluate(
      [
        app('honest', { declaredAnnualIncome: 180_000, ...read(180_000) }),
        app('understated', { declaredAnnualIncome: 120_000, ...read(480_000) }),
      ],
      [link('honest', 'understated')],
    );

    expect(rulesFiredFor(result, 'honest')).not.toContain('DECLARED_INCOME_BELOW_CERTIFICATE');
    expect(rulesFiredFor(result, 'understated')).toContain('DECLARED_INCOME_BELOW_CERTIFICATE');
    expect(result.scores.get('understated')!).toBeGreaterThan(result.scores.get('honest')!);
  });

  it('does not fire when the certificate agrees within tolerance', () => {
    // ₹8,000 apart — 8% — inside both the 15% and the ₹12,000 tolerances.
    const result = evaluate([app('a', { declaredAnnualIncome: 90_000, ...read(98_000) })]);
    expect(rulesFiredFor(result, 'a')).not.toContain('DECLARED_INCOME_BELOW_CERTIFICATE');
  });

  it('does not fire when the applicant declared more than the certificate', () => {
    const result = evaluate([app('a', { declaredAnnualIncome: 200_000, ...read(90_000) })]);
    expect(rulesFiredFor(result, 'a')).not.toContain('DECLARED_INCOME_BELOW_CERTIFICATE');
  });

  it('does not trust a figure OCR was unsure of', () => {
    const result = evaluate([app('a', { declaredAnnualIncome: 120_000, ...read(480_000, 0.5) })]);
    expect(rulesFiredFor(result, 'a')).not.toContain('DECLARED_INCOME_BELOW_CERTIFICATE');
  });

  it('does nothing for an application without a read certificate', () => {
    const result = evaluate([app('a', { declaredAnnualIncome: 120_000 }), app('b', { certificateIncome: null })]);
    expect(result.findings.filter((f) => f.ruleId === 'DECLARED_INCOME_BELOW_CERTIFICATE')).toEqual([]);
  });
});
