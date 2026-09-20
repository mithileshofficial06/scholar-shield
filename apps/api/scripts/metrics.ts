/**
 * Computes every published metric and writes them into README.md.
 *
 *     npm run metrics
 *
 * NOTHING IN THE README TABLE IS TYPED BY HAND
 * --------------------------------------------
 * That is the entire point of this script. A metric a human transcribes drifts
 * from the code the moment either changes, and there is no way for a reader to
 * tell. Everything below is measured on each run and written between markers in
 * the README, so the published figure and the behaviour cannot disagree.
 *
 * WHAT RUNS WHERE
 * ---------------
 * Tier 1 metrics (recall, precision, equity) run in-process through
 * `evaluation/harness.ts` — the same path the test suites use, so a metric can
 * never describe a pipeline that does not exist. Document metrics (OCR
 * accuracy, ELA) are measured by `apps/ocr-service/scripts/corpus_metrics.py`,
 * spawned here, because they need Tesseract and the generated corpus.
 *
 * NO DATABASE IS REQUIRED. The engine is deterministic and database-free by
 * design; Postgres narrows candidates with pg_trgm but scores identically.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRulesConfig } from '../src/household/config.js';
import {
  evaluateCase,
  measureRecall,
  type HarnessCase,
} from '../src/evaluation/harness.js';
import { EQUITY_CASES } from '../../../db/seed/patterns.equity.js';
import { HOLDOUT_CASES } from '../../../db/seed/patterns.holdout.js';
import { RETIRED_HOLDOUT_CASES } from '../../../db/seed/holdout-status.js';
import { SEALED_V2_CASES } from '../../../db/seed/patterns.sealed-v2.js';
import { KNOWN_CASES } from '../../../db/seed/patterns.known.js';
import { CYCLE_DEADLINE } from '../../../db/seed/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const readmePath = path.join(repoRoot, 'README.md');

const START_MARKER = '<!-- METRICS:START -->';
const END_MARKER = '<!-- METRICS:END -->';

interface DocumentMetrics {
  corpus: { documents: number; tampered: number; control: number };
  ocr: {
    fieldAccuracy: number;
    fieldsCorrect: number;
    fieldsTotal: number;
    documentsFullyCorrect: number;
    meanPageConfidence: number;
  };
  ela: {
    tamperedVsControlAuc: number;
    falsePositiveRate: number;
    falsePositives: number;
    controlCount: number;
    meanTamperedScore: number;
    meanControlScore: number;
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Run the Python metrics script in the OCR service's virtualenv.
 *
 * Returns null rather than throwing when the environment is not set up: a
 * developer without Tesseract should still be able to regenerate the Tier 1
 * numbers, and the README says plainly which rows could not be measured rather
 * than silently keeping stale ones.
 */
function documentMetrics(): DocumentMetrics | null {
  const serviceDir = path.join(repoRoot, 'apps', 'ocr-service');
  const candidates = [
    path.join(serviceDir, '.venv', 'Scripts', 'python.exe'),
    path.join(serviceDir, '.venv', 'bin', 'python'),
  ];
  const python = candidates.find((candidate) => existsSync(candidate));

  if (!python) {
    console.warn(
      '! ocr-service virtualenv not found — document metrics skipped.\n' +
        '  See apps/ocr-service/README.md for setup.',
    );
    return null;
  }

  console.log('  running document metrics (this takes a few minutes)...');
  const result = spawnSync(python, ['scripts/corpus_metrics.py', '--json'], {
    cwd: serviceDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.warn(`! document metrics failed:\n${result.stderr?.trim()}`);
    return null;
  }

  try {
    return JSON.parse(result.stdout) as DocumentMetrics;
  } catch {
    console.warn('! document metrics returned unparseable output');
    return null;
  }
}

/**
 * Precision@k and queue lift.
 *
 * The queue is the product, so the metric that matters is whether the top of it
 * is worth a reviewer's time. Every application across the known and equity
 * corpora is scored and ranked; precision@k is the share of the top k that the
 * corpus says should have been flagged, and lift compares the top decile's hit
 * rate against the corpus base rate. Lift of 1.0 means the ranking is no better
 * than reading applications in the order they arrived.
 */
function queueMetrics(config: ReturnType<typeof loadRulesConfig>) {
  const ranked: Array<{ id: string; score: number; shouldFlag: boolean }> = [];

  const corpora = [
    ...KNOWN_CASES.map((c) => ({ seedCase: c as HarnessCase, shouldFlag: c.shouldFlag })),
    // Equity cases are legitimate: nothing in them should surface, so they are
    // the negatives that make precision meaningful rather than automatic.
    ...EQUITY_CASES.map((c) => ({ seedCase: c as HarnessCase, shouldFlag: [] as string[] })),
  ];

  for (const { seedCase, shouldFlag } of corpora) {
    const evaluation = evaluateCase(seedCase, config, CYCLE_DEADLINE);
    const expected = new Set(shouldFlag);

    for (const application of seedCase.applications) {
      const id = `${seedCase.id}::${application.ref}`;
      ranked.push({
        id,
        score: evaluation.scores.get(id) ?? 0,
        shouldFlag: expected.has(application.ref),
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const total = ranked.length;
  const positives = ranked.filter((r) => r.shouldFlag).length;
  const baseRate = positives / total;

  const precisionAt = (k: number): number => {
    const slice = ranked.slice(0, Math.min(k, total));
    if (slice.length === 0) return 0;
    return slice.filter((r) => r.shouldFlag).length / slice.length;
  };

  const decile = Math.max(1, Math.round(total * 0.1));
  const topDecileRate = precisionAt(decile);

  return {
    total,
    positives,
    baseRate,
    precisionAt10: precisionAt(10),
    precisionAt20: precisionAt(20),
    topDecileRate,
    lift: baseRate === 0 ? 0 : topDecileRate / baseRate,
    decileSize: decile,
  };
}

/**
 * Equity pass rate: the share of legitimate-but-anomalous cases producing no
 * high-severity flag.
 *
 * Note what this does and does not prove — the fixtures and the rules share an
 * author, so passing means "the circumstances I anticipated are exempted", not
 * "the system is fair" (PROJECT_REPORT.md §6).
 */
function equityMetrics(config: ReturnType<typeof loadRulesConfig>) {
  let passed = 0;
  const failures: string[] = [];

  for (const equityCase of EQUITY_CASES) {
    const evaluation = evaluateCase(equityCase as HarnessCase, config, CYCLE_DEADLINE);
    if (evaluation.highSeverityRefs.size === 0) {
      passed += 1;
    } else {
      failures.push(`${equityCase.id} (${[...evaluation.highSeverityRefs].join(', ')})`);
    }
  }

  return {
    total: EQUITY_CASES.length,
    passed,
    rate: passed / EQUITY_CASES.length,
    failures,
  };
}

function renderTable(
  known: ReturnType<typeof measureRecall>,
  holdout: ReturnType<typeof measureRecall>,
  sealedV2: ReturnType<typeof measureRecall>,
  queue: ReturnType<typeof queueMetrics>,
  equity: ReturnType<typeof equityMetrics>,
  documents: DocumentMetrics | null,
): string {
  const unmeasured = '_not measured — see notes_';

  const rows: Array<[string, string]> = [
    ['Precision@10', `${pct(queue.precisionAt10)} (base rate ${pct(queue.baseRate)})`],
    [
      'Queue lift (top decile vs. base rate)',
      `${queue.lift.toFixed(2)}× (top ${queue.decileSize} of ${queue.total})`,
    ],
    [
      'Holdout recall (first set — spent, see notes)',
      `${pct(holdout.recall)} (${holdout.caught}/${holdout.expected})`,
    ],
    [
      'Sealed-v2 recall (pre-registered, no rule targets it)',
      `${pct(sealedV2.recall)} (${sealedV2.caught}/${sealedV2.expected})`,
    ],
    ['Known recall', `${pct(known.recall)} (${known.caught}/${known.expected})`],
    [
      'ELA false-positive rate',
      documents
        ? `${pct(documents.ela.falsePositiveRate)} (${documents.ela.falsePositives}/${documents.ela.controlCount} controls)`
        : unmeasured,
    ],
    [
      'ELA tampered-vs-control AUC',
      documents ? `${documents.ela.tamperedVsControlAuc.toFixed(3)} (0.500 = chance)` : unmeasured,
    ],
    [
      'OCR field accuracy (degraded corpus)',
      documents
        ? `${pct(documents.ocr.fieldAccuracy)} (${documents.ocr.fieldsCorrect}/${documents.ocr.fieldsTotal})`
        : unmeasured,
    ],
    [
      'OCR documents fully correct',
      documents
        ? `${documents.ocr.documentsFullyCorrect}/${documents.corpus.documents}`
        : unmeasured,
    ],
    ['Equity pass rate', `${pct(equity.rate)} (${equity.passed}/${equity.total} cases)`],
  ];

  const table = [
    '| Metric | Value |',
    '|---|---|',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
  ].join('\n');

  const generated = new Date().toISOString().slice(0, 10);

  const targetedCaught = RETIRED_HOLDOUT_CASES.filter((c) => c.caught).length;
  const targetedTotal = RETIRED_HOLDOUT_CASES.length;

  const holdoutNote = [
    '',
    `**The sealed holdout is spent, and ${pct(holdout.recall)} is no longer a clean ` +
      'generalisation number.** It was one at v3, when it read 38.2%. The data has not ' +
      'changed — `patterns.holdout.ts` is byte-identical and `git log --diff-filter=A` ' +
      'still shows it committed a day before any rule code. What changed is that the v3 ' +
      'metrics note *named the missing rule families*, and the v4 rules were written ' +
      'against those mechanisms. The sealed case data was never opened, and no threshold ' +
      'was chosen by checking what a case needed — but the decision about what to build ' +
      'was informed by this set\'s own results. That is leakage. It is the ordinary way a ' +
      'project learns from an evaluation, and it is still reported rather than absorbed.',
    '',
    `Why no slice of it can be quoted instead: ${targetedTotal} cases are now explicitly ` +
      'targeted (`db/seed/holdout-status.ts`), and they are *exactly* the cases v3 ' +
      'missed. Recall over the remainder is therefore 100% by construction, which ' +
      'measures nothing at all. There is no honest sub-number left in this set.',
    '',
    `Of the ${targetedTotal} mechanisms v4 now targets, ${targetedCaught} are caught and ` +
      `${targetedTotal - targetedCaught} are still missed *with a rule written for them* — ` +
      'kept visible because a rule that targets a mechanism and still fails to surface it ' +
      'is the more useful fact:',
    '',
    ...RETIRED_HOLDOUT_CASES.map(
      (c) =>
        '- `' + c.caseId + '` → `' + c.targetedBy + '` (' + c.since + '): ' +
        `**${c.caught ? 'caught' : 'still missed'}**. ${c.note}`,
    ),
    '',
    '**The next honest number requires a new sealed set.** `patterns.sealed-v2.ts` is ' +
      'authored against mechanisms no rule targets, and committed before any rule that ' +
      'might catch them. It carries a weaker claim than the original — it shares an ' +
      'author with the engine, where the original was deliberately written first — and ' +
      'its own header says so.',
  ].join('\n');

  const documentNote = documents
    ? [
        '',
        `**ELA carries no usable signal on this corpus.** An AUC of ` +
          `${documents.ela.tamperedVsControlAuc.toFixed(3)} against matched controls is chance: ` +
          `mean score ${documents.ela.meanTamperedScore.toFixed(3)} on tampered documents versus ` +
          `${documents.ela.meanControlScore.toFixed(3)} on untampered ones with identical ` +
          'compression history. This is a measured negative result, not an unfinished ' +
          'feature — the control group exists precisely so this could be detected rather ' +
          'than assumed (PROJECT_REPORT.md §7.3). Tier 2 is weighted accordingly.',
      ].join('\n')
    : [
        '',
        '_Document metrics were not measured on this run: the OCR service virtualenv or ' +
          'the generated corpus was unavailable. See apps/ocr-service/README.md._',
      ].join('\n');

  return [
    START_MARKER,
    '',
    `_Generated by \`npm run metrics\` on ${generated}. Never hand-edited._`,
    '',
    table,
    holdoutNote,
    documentNote,
    '',
    END_MARKER,
  ].join('\n');
}

function main(): void {
  const config = loadRulesConfig();

  console.log('scholarshield metrics\n');

  const known = measureRecall(KNOWN_CASES, config, CYCLE_DEADLINE);
  const holdout = measureRecall(HOLDOUT_CASES as never, config, CYCLE_DEADLINE);
  // Pre-registered: no rule targets any mechanism in this set, so whatever it
  // catches, it catches by generalising. Measured now, before v5 exists.
  const sealedV2 = measureRecall(SEALED_V2_CASES as never, config, CYCLE_DEADLINE);
  const queue = queueMetrics(config);
  const equity = equityMetrics(config);
  const documents = documentMetrics();

  console.log(`  known recall     ${pct(known.recall)} (${known.caught}/${known.expected})`);
  console.log(`  holdout recall   ${pct(holdout.recall)} (${holdout.caught}/${holdout.expected})`);
  if (holdout.missed.length) {
    console.log(`    missed: ${holdout.missed.join(', ')}`);
  }
  console.log(
    `  sealed-v2 recall ${pct(sealedV2.recall)} (${sealedV2.caught}/${sealedV2.expected})  [pre-registered]`,
  );
  console.log(`  precision@10     ${pct(queue.precisionAt10)} (base ${pct(queue.baseRate)})`);
  console.log(`  queue lift       ${queue.lift.toFixed(2)}x`);
  console.log(`  equity pass      ${pct(equity.rate)} (${equity.passed}/${equity.total})`);
  if (equity.failures.length) {
    console.log(`    failing: ${equity.failures.join(', ')}`);
  }
  if (documents) {
    console.log(`  ocr accuracy     ${pct(documents.ocr.fieldAccuracy)}`);
    console.log(`  ela auc          ${documents.ela.tamperedVsControlAuc.toFixed(3)}`);
  }

  const readme = readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1) {
    console.error(
      `\n! README.md is missing the ${START_MARKER} / ${END_MARKER} markers; ` +
        'metrics were computed but not written.',
    );
    process.exitCode = 1;
    return;
  }

  const updated =
    readme.slice(0, start) +
    renderTable(known, holdout, sealedV2, queue, equity, documents) +
    readme.slice(end + END_MARKER.length);

  writeFileSync(readmePath, updated);
  console.log('\n  README.md updated.');
}

main();
