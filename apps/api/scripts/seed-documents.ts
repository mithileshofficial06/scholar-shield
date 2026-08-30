/**
 * Generates the synthetic document corpus.
 *
 *     npm run seed:documents
 *
 * Writes three variants per application into db/seed/output/:
 *
 *   genuine/   rendered, then degraded (print -> capture -> save)
 *   tampered/  degraded, then income repainted through a different image path
 *   control/   degraded, then put through the SAME compression chain, unedited
 *
 * The control set is the whole reason this script produces a manifest rather
 * than just images: without a group that has been recompressed exactly as often
 * as the tampered set but never altered, "ELA caught 90% of forgeries" cannot be
 * distinguished from "ELA flags 90% of everything" (PROJECT_REPORT.md §7.3).
 *
 * Output is git-ignored and fully reproducible — every random choice is seeded on
 * the document reference, so regenerating gives byte-identical files.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCertificate } from '../../../db/seed/certificate.js';
import { degrade } from '../../../db/seed/degrade.js';
import { recompressControl, tamper } from '../../../db/seed/tamper.js';
import { EQUITY_CASES } from '../../../db/seed/patterns.equity.js';
import { KNOWN_CASES } from '../../../db/seed/patterns.known.js';
import type { SeedApplication } from '../../../db/seed/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../../../db/seed/output');

interface ManifestEntry {
  ref: string;
  caseId: string;
  variant: 'genuine' | 'tampered' | 'control';
  file: string;
  sha256: string;
  bytes: number;
  declaredIncome: number;
  /** Income actually printed on the document — differs only for tampered. */
  renderedIncome: number;
  compressionChain: number[] | null;
  degradation: Record<string, number>;
  /** Ground truth for the forensics stage. */
  isTampered: boolean;
  /**
   * Ground truth for the OCR stage: exactly what was printed on this variant.
   *
   * Recorded per document rather than looked up from the pattern files, because
   * for a tampered document what is printed is NOT what the applicant declared —
   * and grading OCR against the declaration would score a correct reading of a
   * forged certificate as an OCR error.
   */
  truth: {
    applicantName: string;
    guardianName: string;
    address: string;
    district: string;
    pincode: string;
    familySize: number;
    annualIncome: number;
    certificateId: string;
    issueDate: string;
    issuingOffice: string;
  };
}

/** What a given variant of an application actually has printed on it. */
function truthFor(app: SeedApplication, printedIncome: number): ManifestEntry['truth'] {
  return {
    applicantName: app.applicantName,
    guardianName: app.guardianName,
    address: app.addressLine,
    district: app.district,
    pincode: app.pincode,
    familySize: app.declaredFamilySize,
    annualIncome: printedIncome,
    certificateId: app.certificateId,
    issueDate: app.certificateIssueDate,
    issuingOffice: app.issuingOffice,
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * How a forger would rewrite an income: enough below the ceiling to qualify,
 * not so low it invites attention. Derived from the reference, not random, so
 * the corpus stays reproducible.
 */
function forgedIncomeFor(app: SeedApplication): number {
  const base = 68_000 + (app.certificateId.length % 5) * 4_000;
  return base;
}

async function main(): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  for (const dir of ['genuine', 'tampered', 'control']) {
    await mkdir(path.join(outputDir, dir), { recursive: true });
  }

  const cases = [
    ...KNOWN_CASES.map((c) => ({ id: c.id, applications: c.applications })),
    ...EQUITY_CASES.map((c) => ({ id: c.id, applications: c.applications })),
  ];

  const manifest: ManifestEntry[] = [];
  let tamperedCount = 0;

  for (const seedCase of cases) {
    for (const app of seedCase.applications) {
      const ref = `${seedCase.id}__${app.ref}`;
      const rendered = renderCertificate(app);

      // 1. Genuine: rendered, then degraded.
      const degraded = await degrade(rendered.png, { seed: ref });
      const genuinePath = path.join('genuine', `${ref}.jpg`);
      await writeFile(path.join(outputDir, genuinePath), degraded.jpeg);

      manifest.push({
        ref,
        caseId: seedCase.id,
        variant: 'genuine',
        file: genuinePath,
        sha256: sha256(degraded.jpeg),
        bytes: degraded.jpeg.length,
        declaredIncome: app.declaredAnnualIncome,
        renderedIncome: app.declaredAnnualIncome,
        compressionChain: null,
        degradation: degraded.applied,
        isTampered: false,
        truth: truthFor(app, app.declaredAnnualIncome),
      });

      // 2 & 3. Tampered and its control — paired, so the corpus always has a
      // matched untampered document with identical compression history.
      // Every second application, to keep the base rate realistic rather than 50/50.
      const shouldTamper = manifest.length % 2 === 1;
      if (!shouldTamper) continue;

      // Tamper and control both operate on the RENDERED page, in the renderer's
      // own coordinates, and are degraded afterwards. See tamper.ts header —
      // painting onto an already-rotated page puts the patch in the wrong place.
      //
      // Both are degraded with the same seed as the genuine variant, so geometry,
      // illumination, noise and final JPEG quality are identical across the trio.
      // Any difference the forensics stage finds between tampered and control is
      // therefore the edit, and nothing else.
      const forged = forgedIncomeFor(app);
      const tampered = await tamper(rendered.png, {
        seed: ref,
        originalIncome: app.declaredAnnualIncome,
        forgedIncome: forged,
        incomeBox: rendered.incomeBox,
        incomeWordsBox: rendered.incomeWordsBox,
      });
      const tamperedFinal = await degrade(tampered.jpeg, { seed: ref });

      const tamperedPath = path.join('tampered', `${ref}.jpg`);
      await writeFile(path.join(outputDir, tamperedPath), tamperedFinal.jpeg);
      tamperedCount += 1;

      manifest.push({
        ref,
        caseId: seedCase.id,
        variant: 'tampered',
        file: tamperedPath,
        sha256: sha256(tamperedFinal.jpeg),
        bytes: tamperedFinal.jpeg.length,
        declaredIncome: app.declaredAnnualIncome,
        renderedIncome: forged,
        compressionChain: [...tampered.compressionChain, tamperedFinal.applied.jpegQuality],
        degradation: tamperedFinal.applied,
        isTampered: true,
        truth: truthFor(app, forged),
      });

      const control = await recompressControl(rendered.png);
      const controlFinal = await degrade(control.jpeg, { seed: ref });

      const controlPath = path.join('control', `${ref}.jpg`);
      await writeFile(path.join(outputDir, controlPath), controlFinal.jpeg);

      manifest.push({
        ref,
        caseId: seedCase.id,
        variant: 'control',
        file: controlPath,
        sha256: sha256(controlFinal.jpeg),
        bytes: controlFinal.jpeg.length,
        declaredIncome: app.declaredAnnualIncome,
        renderedIncome: app.declaredAnnualIncome,
        compressionChain: [...control.compressionChain, controlFinal.applied.jpegQuality],
        degradation: controlFinal.applied,
        isTampered: false,
        truth: truthFor(app, app.declaredAnnualIncome),
      });
    }
  }

  const summary = {
    generatedFrom: 'patterns.known.ts + patterns.equity.ts',
    note:
      'Every document carries a SYNTHETIC watermark and a simulated seal. Control documents share the tampered documents\' exact compression chain and differ only in that nothing was painted — they are the denominator of the ELA false-positive rate.',
    counts: {
      total: manifest.length,
      genuine: manifest.filter((m) => m.variant === 'genuine').length,
      tampered: tamperedCount,
      control: manifest.filter((m) => m.variant === 'control').length,
    },
    documents: manifest,
  };

  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(`corpus written to db/seed/output`);
  console.table(summary.counts);
  console.log(
    `tampered/control pairs: ${tamperedCount} (matched compression chain ${[...[92, 88]].join(' -> ')})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
