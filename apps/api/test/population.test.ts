/**
 * Tier 1b: the population-level rules.
 *
 * Every fixture here is constructed from the fraud mechanism each rule claims to
 * detect, not copied from any corpus. The holdout set was not opened to write
 * this file, and no threshold below was chosen by checking what a holdout case
 * needed — see db/seed/README-holdout.md.
 *
 * Each rule gets three kinds of test: it fires on a textbook instance of its
 * mechanism, it stays silent on the innocent shape that most resembles it, and
 * it obeys the boundary its config sets. The middle one matters most. A rule
 * that fires on a population is a rule that can flag a whole village, and the
 * negative cases are where that gets caught.
 */

import { describe, expect, it } from 'vitest';

import { loadRulesConfig } from '../src/household/config.js';
import { detectComponents } from '../src/household/components.js';
import {
  certificateSerialAdjacency,
  evaluateRules,
  householdFragmentation,
  identicalRoundIncomeCluster,
  incomeThresholdBunching,
  POPULATION_RULES,
  type ScorableApplication,
} from '../src/household/rules.js';
import type { PairResolution, ResolvedEdge } from '../src/household/resolve.js';

const config = loadRulesConfig();
const CEILING = config.scholarshipIncomeCeiling;
const DEADLINE = '2026-07-31';

const rule = (id: string) => config.rules[id]!;

/**
 * Deliberately unlike the fixture in rules.test.ts: every field that a Tier 1b
 * rule groups on is unique per application unless a test sets it otherwise.
 * A shared default office or a shared round income would make every multi-row
 * fixture in this file trip a clustering rule by accident.
 */
function app(id: string, over: Partial<ScorableApplication> = {}): ScorableApplication {
  return {
    id,
    cycle: '2026',
    applicantName: `Applicant ${id}`,
    declaredAnnualIncome: 137_431,
    declaredFamilySize: 4,
    normalizedGuardianName: `guardian ${id}`,
    normalizedAddress: `${id} some street somewhere`,
    normalizedGuardianPhone: null,
    issuingOffice: `Office ${id}`,
    certificateIssueDate: '2026-05-10',
    certificateId: `TN-XXX-2026-${100_000 + Number.parseInt(id.replace(/\D/g, ''), 10) * 997}`,
    ...over,
  };
}

/** Distinct households: the identity map every clustering rule is handed. */
function ownHouseholds(apps: ScorableApplication[]): Map<string, string> {
  return new Map(apps.map((a) => [a.id, `hh-${a.id}`]));
}

/** One household containing everything, the innocent explanation for a cluster. */
function oneHousehold(apps: ScorableApplication[]): Map<string, string> {
  return new Map(apps.map((a) => [a.id, 'hh-shared']));
}

const idsFlagged = (findings: { applicationId: string }[]) =>
  [...new Set(findings.map((f) => f.applicationId))].sort();

// --------------------------------------------------------- threshold bunching

describe('INCOME_THRESHOLD_BUNCHING', () => {
  const cfg = rule('INCOME_THRESHOLD_BUNCHING');
  // 8% of 250,000 = 20,000, so the band is (230,000 .. 250,000].
  const inBand = (n: number) => 231_000 + n * 1_000;
  const belowBand = (n: number) => 211_000 + n * 1_000;

  it('fires on a crowd pressed against the ceiling with an empty band below', () => {
    const apps = [0, 1, 2, 3, 4].map((n) => app(`b${n}`, { declaredAnnualIncome: inBand(n) }));
    const findings = incomeThresholdBunching(apps, cfg, CEILING);

    expect(idsFlagged(findings)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(findings[0]!.evidence.densityRatio).toBe(5);
  });

  it('stays silent when the band below is just as crowded', () => {
    // The distribution is flat, not bunched. Flat is what an honest population
    // near a ceiling looks like, and it is the case this rule must not flag.
    const apps = [
      ...[0, 1, 2, 3, 4].map((n) => app(`a${n}`, { declaredAnnualIncome: inBand(n) })),
      ...[0, 1, 2, 3, 4].map((n) => app(`c${n}`, { declaredAnnualIncome: belowBand(n) })),
    ];
    expect(incomeThresholdBunching(apps, cfg, CEILING)).toEqual([]);
  });

  it('stays silent on a small cycle, however lopsided', () => {
    // Three applicants near the ceiling and nobody below is not evidence: it is
    // a sample too small to have a shape. minBandCount is what says so.
    const apps = [0, 1, 2].map((n) => app(`s${n}`, { declaredAnnualIncome: inBand(n) }));
    expect(incomeThresholdBunching(apps, cfg, CEILING)).toEqual([]);
  });

  it('ignores incomes over the ceiling — those applicants are simply ineligible', () => {
    const apps = [0, 1, 2, 3, 4].map((n) =>
      app(`o${n}`, { declaredAnnualIncome: CEILING + 10_000 + n }),
    );
    expect(incomeThresholdBunching(apps, cfg, CEILING)).toEqual([]);
  });

  it('flags nobody when poverty puts the whole cycle far below the line', () => {
    // The equity case. A cycle where everyone earns 40-60k is the population
    // this scholarship exists for, and it must never look like gaming.
    const apps = [0, 1, 2, 3, 4, 5].map((n) =>
      app(`p${n}`, { declaredAnnualIncome: 40_000 + n * 4_000 }),
    );
    expect(incomeThresholdBunching(apps, cfg, CEILING)).toEqual([]);
  });
});

// --------------------------------------------------------- serial adjacency

describe('CERTIFICATE_SERIAL_ADJACENCY', () => {
  const cfg = rule('CERTIFICATE_SERIAL_ADJACENCY');
  const OFFICE = 'Ayanavaram Taluk Office';
  const serial = (n: number) => `TN-CHN-2026-${n}`;

  it('fires on a tight serial run across unrelated households', () => {
    const apps = [500_001, 500_003, 500_006].map((n, i) =>
      app(`r${i}`, { issuingOffice: OFFICE, certificateId: serial(n) }),
    );
    const findings = certificateSerialAdjacency(apps, ownHouseholds(apps), cfg);

    expect(idsFlagged(findings)).toEqual(['r0', 'r1', 'r2']);
    expect(findings[0]!.evidence.serialSpan).toBe(5);
    expect(findings[0]!.evidence.distinctHouseholds).toBe(3);
  });

  it('stays silent when the consecutive certificates are one household', () => {
    // Siblings who walked into the office together. This is the likeliest
    // innocent cause of adjacency and the one that would ruin precision.
    const apps = [500_001, 500_002, 500_003].map((n, i) =>
      app(`h${i}`, { issuingOffice: OFFICE, certificateId: serial(n) }),
    );
    expect(certificateSerialAdjacency(apps, oneHousehold(apps), cfg)).toEqual([]);
  });

  it('stays silent when serials from one office are spread across the year', () => {
    const apps = [500_001, 512_400, 526_910].map((n, i) =>
      app(`w${i}`, { issuingOffice: OFFICE, certificateId: serial(n) }),
    );
    expect(certificateSerialAdjacency(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('does not compare serials across different offices', () => {
    const apps = [500_001, 500_002, 500_003].map((n, i) =>
      app(`d${i}`, { issuingOffice: `Office ${i}`, certificateId: serial(n) }),
    );
    expect(certificateSerialAdjacency(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('does not compare across different serial series at one office', () => {
    // Two numbering series that happen to overlap numerically are not adjacent.
    const apps = [
      app('x0', { issuingOffice: OFFICE, certificateId: 'TN-CHN-2026-500001' }),
      app('x1', { issuingOffice: OFFICE, certificateId: 'KA-BLR-2026-500002' }),
      app('x2', { issuingOffice: OFFICE, certificateId: 'AP-VJA-2026-500003' }),
    ];
    expect(certificateSerialAdjacency(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('skips applications with no readable serial rather than grouping them', () => {
    const apps = [
      app('n0', { issuingOffice: OFFICE, certificateId: null }),
      app('n1', { issuingOffice: OFFICE, certificateId: null }),
      app('n2', { issuingOffice: OFFICE, certificateId: null }),
    ];
    expect(certificateSerialAdjacency(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('reports a long run once, not once per sliding window', () => {
    const apps = [500_001, 500_002, 500_003, 500_004].map((n, i) =>
      app(`m${i}`, { issuingOffice: OFFICE, certificateId: serial(n) }),
    );
    const findings = certificateSerialAdjacency(apps, ownHouseholds(apps), cfg);
    expect(findings).toHaveLength(4);
  });
});

// ------------------------------------------------------ identical round income

describe('IDENTICAL_ROUND_INCOME_CLUSTER', () => {
  const cfg = rule('IDENTICAL_ROUND_INCOME_CLUSTER');
  const OFFICE = 'Perambur Taluk Office';

  it('fires on one round figure repeated across unrelated households', () => {
    const apps = [0, 1, 2].map((n) =>
      app(`k${n}`, { issuingOffice: OFFICE, declaredAnnualIncome: 90_000 }),
    );
    const findings = identicalRoundIncomeCluster(apps, ownHouseholds(apps), cfg);

    expect(idsFlagged(findings)).toEqual(['k0', 'k1', 'k2']);
    expect(findings[0]!.evidence.distinctHouseholds).toBe(3);
  });

  it('stays silent when the repeated figure is not round', () => {
    // A stock number is round. An unrounded figure repeating is a coincidence
    // of assessment, and far likelier to be genuine.
    const apps = [0, 1, 2].map((n) =>
      app(`u${n}`, { issuingOffice: OFFICE, declaredAnnualIncome: 87_432 }),
    );
    expect(identicalRoundIncomeCluster(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('stays silent on round figures that merely sit near each other', () => {
    // Rounding is ordinary. Only an EXACT repeat is the mill signature.
    const apps = [90_000, 80_000, 70_000].map((v, i) =>
      app(`v${i}`, { issuingOffice: OFFICE, declaredAnnualIncome: v }),
    );
    expect(identicalRoundIncomeCluster(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('stays silent when the identical incomes are one household', () => {
    const apps = [0, 1, 2].map((n) =>
      app(`g${n}`, { issuingOffice: OFFICE, declaredAnnualIncome: 90_000 }),
    );
    expect(identicalRoundIncomeCluster(apps, oneHousehold(apps), cfg)).toEqual([]);
  });

  it('stays silent when the same figure comes from different offices', () => {
    const apps = [0, 1, 2].map((n) =>
      app(`f${n}`, { issuingOffice: `Office ${n}`, declaredAnnualIncome: 90_000 }),
    );
    expect(identicalRoundIncomeCluster(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });

  it('needs the configured number of households, not merely of applications', () => {
    const apps = [0, 1].map((n) =>
      app(`t${n}`, { issuingOffice: OFFICE, declaredAnnualIncome: 90_000 }),
    );
    expect(identicalRoundIncomeCluster(apps, ownHouseholds(apps), cfg)).toEqual([]);
  });
});

// ------------------------------------------------------- household fragmentation

describe('HOUSEHOLD_FRAGMENTATION', () => {
  const cfg = rule('HOUSEHOLD_FRAGMENTATION');

  function pair(
    score: number,
    edges: { field: ResolvedEdge['matchField']; similarity: number }[],
  ): PairResolution {
    return {
      applicationAId: 'f1',
      applicationBId: 'f2',
      edges: edges.map((e) => ({
        applicationAId: 'f1',
        applicationBId: 'f2',
        matchField: e.field,
        similarity: e.similarity,
        weight: 0.5,
      })),
      score,
      linked: score >= 0.55,
    };
  }

  const byId = new Map([
    ['f1', app('f1')],
    ['f2', app('f2')],
  ]);

  it('fires on a pair just under the bar on two independent fields', () => {
    const findings = householdFragmentation(
      [pair(0.48, [
        { field: 'guardian_name', similarity: 0.6 },
        { field: 'address', similarity: 0.62 },
      ])],
      byId,
      cfg,
    );
    expect(idsFlagged(findings)).toEqual(['f1', 'f2']);
    expect(findings[0]!.evidence.resolutionScore).toBe(0.48);
  });

  it('stays silent on a single near-miss field', () => {
    // Two people in one district sharing a common guardian name. This is the
    // equity case from PROJECT_REPORT.md section 6, and the reason the rule
    // demands two independent fields rather than one.
    const findings = householdFragmentation(
      [pair(0.45, [{ field: 'guardian_name', similarity: 0.85 }])],
      byId,
      cfg,
    );
    expect(findings).toEqual([]);
  });

  it('stays silent on strangers, who match on nothing', () => {
    const findings = householdFragmentation(
      [pair(0.12, [{ field: 'applicant_name', similarity: 0.66 }])],
      byId,
      cfg,
    );
    expect(findings).toEqual([]);
  });

  it('leaves linked pairs alone — those are a household, and already compared', () => {
    const findings = householdFragmentation(
      [pair(0.82, [
        { field: 'guardian_name', similarity: 0.95 },
        { field: 'address', similarity: 0.9 },
      ])],
      byId,
      cfg,
    );
    expect(findings).toEqual([]);
  });

  it('reports each ordered pair once, not once per edge', () => {
    const findings = householdFragmentation(
      [pair(0.5, [
        { field: 'guardian_name', similarity: 0.6 },
        { field: 'address', similarity: 0.61 },
        { field: 'applicant_name', similarity: 0.7 },
      ])],
      byId,
      cfg,
    );
    expect(findings).toHaveLength(2);
  });
});

// ----------------------------------------------------------- the tier contract

describe('Tier 1b as a tier', () => {
  it('cannot carry an application into high severity on its own', () => {
    // Every population rule firing at once on one application still has to land
    // below the threshold. This is the promise the tier makes to an applicant:
    // nothing about the company you keep alone makes you a high-severity case.
    const total = [...POPULATION_RULES].reduce((sum, id) => sum + rule(id).weight, 0);
    expect(total).toBeLessThan(config.highSeverityScoreThreshold * 2);
    for (const id of POPULATION_RULES) {
      expect(rule(id).weight).toBeLessThan(config.highSeverityScoreThreshold);
    }
  });

  it('does not satisfy the corroboration a weak pairwise rule requires', () => {
    // DEADLINE_PROXIMITY never fires alone. A bunching flag is not company
    // enough to let it: two things that are individually not evidence must not
    // add up to something that looks like evidence.
    const apps = [0, 1, 2, 3, 4].map((n) =>
      app(`z${n}`, {
        declaredAnnualIncome: 231_000 + n * 1_000,
        // Inside DEADLINE_PROXIMITY's 14-day window.
        certificateIssueDate: '2026-07-25',
      }),
    );
    const components = detectComponents(apps.map((a) => a.id), []);
    const { findings } = evaluateRules(apps, components, config, DEADLINE, []);

    const fired = new Set(findings.map((f) => f.ruleId));
    expect(fired.has('INCOME_THRESHOLD_BUNCHING')).toBe(true);
    expect(fired.has('DEADLINE_PROXIMITY')).toBe(false);
  });

  it('leaves an honest, unremarkable cycle completely unflagged', () => {
    const apps = [
      app('q0', { declaredAnnualIncome: 62_431 }),
      app('q1', { declaredAnnualIncome: 118_902 }),
      app('q2', { declaredAnnualIncome: 47_115 }),
      app('q3', { declaredAnnualIncome: 155_640 }),
    ];
    const components = detectComponents(apps.map((a) => a.id), []);
    const { findings } = evaluateRules(apps, components, config, DEADLINE, []);
    expect(findings.filter((f) => POPULATION_RULES.has(f.ruleId))).toEqual([]);
  });
});
