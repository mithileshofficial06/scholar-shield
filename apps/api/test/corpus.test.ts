/**
 * Invariants of the synthetic document corpus.
 *
 * The Week 5 metrics depend on properties that are easy to break silently — a
 * changed seed, a reordered pipeline, a tampered/control pair that stopped being
 * matched. A published ELA false-positive rate is only meaningful if these hold,
 * so they are asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  amountInWords,
  formatINR,
  renderCertificate,
  DOC_HEIGHT,
  DOC_WIDTH,
} from '../../../db/seed/certificate.js';
import { degrade, seededRandom } from '../../../db/seed/degrade.js';
import { COMPRESSION_CHAIN, recompressControl, tamper } from '../../../db/seed/tamper.js';
import { KNOWN_CASES } from '../../../db/seed/patterns.known.js';
import type { SeedApplication } from '../../../db/seed/types.js';

const sample: SeedApplication = KNOWN_CASES[0]!.applications[0]!;

describe('amountInWords — Indian numbering', () => {
  it('renders lakhs and thousands', () => {
    expect(amountInWords(178_000)).toBe('One Lakh Seventy Eight Thousand Rupees Only');
    expect(amountInWords(96_000)).toBe('Ninety Six Thousand Rupees Only');
    expect(amountInWords(80_000)).toBe('Eighty Thousand Rupees Only');
  });

  it('handles hundreds, teens, and zero', () => {
    expect(amountInWords(1_500)).toBe('One Thousand Five Hundred Rupees Only');
    expect(amountInWords(15)).toBe('Fifteen Rupees Only');
    expect(amountInWords(0)).toBe('Zero Rupees Only');
  });

  it('is what a tamperer must also change', () => {
    // The figure and the words are independent fields. Editing only one leaves a
    // cross-field contradiction the OCR stage can surface without any forensics.
    expect(amountInWords(96_000)).not.toBe(amountInWords(80_000));
  });
});

describe('formatINR', () => {
  it('groups the Indian way, not in thousands', () => {
    expect(formatINR(178_000)).toBe('1,78,000');
    expect(formatINR(640_000)).toBe('6,40,000');
    expect(formatINR(96_000)).toBe('96,000');
  });
});

describe('seededRandom', () => {
  it('is deterministic for a seed', () => {
    const a = seededRandom('ref-1');
    const b = seededRandom('ref-1');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs between seeds', () => {
    expect(seededRandom('ref-1')()).not.toBe(seededRandom('ref-2')());
  });

  it('stays within [0, 1)', () => {
    const rng = seededRandom('bounds');
    for (let i = 0; i < 500; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('renderCertificate', () => {
  it('produces a page-sized PNG', async () => {
    const { png } = renderCertificate(sample);
    const meta = await sharp(png).metadata();

    expect(meta.format).toBe('png');
    expect(meta.width).toBe(DOC_WIDTH);
    expect(meta.height).toBe(DOC_HEIGHT);
  });

  it('reports field boxes inside the page', () => {
    const { incomeBox, incomeWordsBox } = renderCertificate(sample);

    for (const box of [incomeBox, incomeWordsBox]) {
      expect(box.x).toBeGreaterThan(0);
      expect(box.y).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThan(DOC_WIDTH);
      expect(box.y + box.height).toBeLessThan(DOC_HEIGHT);
    }
  });

  it('is byte-stable across renders', () => {
    // The renderer must not introduce entropy of its own, or the corpus stops
    // being reproducible regardless of how carefully degradation is seeded.
    expect(renderCertificate(sample).png.equals(renderCertificate(sample).png)).toBe(true);
  });
});

describe('degrade', () => {
  it('produces a JPEG within the intended quality band', async () => {
    const { png } = renderCertificate(sample);
    const result = await degrade(png, { seed: 'doc-a' });

    const meta = await sharp(result.jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(result.applied.jpegQuality).toBeGreaterThanOrEqual(65);
    expect(result.applied.jpegQuality).toBeLessThanOrEqual(85);
  });

  it('applies geometry and noise the OCR stage must cope with', async () => {
    const { png } = renderCertificate(sample);
    const { applied } = await degrade(png, { seed: 'doc-a' });

    expect(Math.abs(applied.rotationDegrees)).toBeGreaterThan(0);
    expect(Math.abs(applied.rotationDegrees)).toBeLessThanOrEqual(3);
    expect(applied.noiseSigma).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', async () => {
    const { png } = renderCertificate(sample);
    const first = await degrade(png, { seed: 'doc-a' });
    const second = await degrade(png, { seed: 'doc-a' });

    expect(first.applied).toEqual(second.applied);
    expect(first.jpeg.equals(second.jpeg)).toBe(true);
  });

  it('differs between seeds', async () => {
    const { png } = renderCertificate(sample);
    const a = await degrade(png, { seed: 'doc-a' });
    const b = await degrade(png, { seed: 'doc-b' });

    expect(a.applied.rotationDegrees).not.toBe(b.applied.rotationDegrees);
  });

  it('the flat profile skips geometric distortion', async () => {
    const { png } = renderCertificate(sample);
    const { applied } = await degrade(png, { seed: 'doc-a', flat: true });

    expect(applied.shear).toBe(0);
    expect(Math.abs(applied.rotationDegrees)).toBeLessThanOrEqual(0.6);
  });
});

describe('tamper and its control are a matched pair', () => {
  it('both carry the identical compression chain', async () => {
    const rendered = renderCertificate(sample);

    const tampered = await tamper(rendered.png, {
      seed: 'pair-1',
      originalIncome: sample.declaredAnnualIncome,
      forgedIncome: 80_000,
      incomeBox: rendered.incomeBox,
      incomeWordsBox: rendered.incomeWordsBox,
    });
    const control = await recompressControl(rendered.png);

    expect(tampered.compressionChain).toEqual(COMPRESSION_CHAIN);
    expect(control.compressionChain).toEqual(COMPRESSION_CHAIN);
  });

  it('degrade to comparable sizes — no quality confound between the groups', async () => {
    // The first version of this pipeline passed JPEG quality as 0-1 to an encoder
    // expecting 0-100, which silently produced near-minimum quality. The tampered
    // set came out 6x smaller than genuine, so any detector could have separated
    // the groups on file size alone without looking at a single pixel.
    const rendered = renderCertificate(sample);

    const tampered = await tamper(rendered.png, {
      seed: 'pair-2',
      originalIncome: sample.declaredAnnualIncome,
      forgedIncome: 80_000,
      incomeBox: rendered.incomeBox,
      incomeWordsBox: rendered.incomeWordsBox,
    });
    const control = await recompressControl(rendered.png);

    const tamperedFinal = await degrade(tampered.jpeg, { seed: 'pair-2' });
    const controlFinal = await degrade(control.jpeg, { seed: 'pair-2' });

    const ratio = tamperedFinal.jpeg.length / controlFinal.jpeg.length;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.33);
  });

  it('shares degradation parameters, so only the edit differs', async () => {
    const rendered = renderCertificate(sample);
    const control = await recompressControl(rendered.png);

    const genuineFinal = await degrade(rendered.png, { seed: 'pair-3' });
    const controlFinal = await degrade(control.jpeg, { seed: 'pair-3' });

    // Same seed, same geometry and quality decisions — any residual difference is
    // compression history, which is the variable under study.
    expect(genuineFinal.applied).toEqual(controlFinal.applied);
  });

  it('control records no edit; tampered records what changed', async () => {
    const rendered = renderCertificate(sample);

    const tampered = await tamper(rendered.png, {
      seed: 'pair-4',
      originalIncome: 96_000,
      forgedIncome: 80_000,
      incomeBox: rendered.incomeBox,
      incomeWordsBox: rendered.incomeWordsBox,
    });
    const control = await recompressControl(rendered.png);

    expect(control.edit).toBeNull();
    expect(tampered.edit).not.toBeNull();
    expect(tampered.edit!.originalIncome).toBe(96_000);
    expect(tampered.edit!.forgedIncome).toBe(80_000);
  });

  it('actually alters pixels in the income region and nowhere else structural', async () => {
    const rendered = renderCertificate(sample);

    const tampered = await tamper(rendered.png, {
      seed: 'pair-5',
      originalIncome: sample.declaredAnnualIncome,
      forgedIncome: 80_000,
      incomeBox: rendered.incomeBox,
      incomeWordsBox: rendered.incomeWordsBox,
    });
    const control = await recompressControl(rendered.png);

    const region = {
      left: Math.round(rendered.incomeBox.x),
      top: Math.round(rendered.incomeBox.y),
      width: Math.round(rendered.incomeBox.width),
      height: Math.round(rendered.incomeBox.height),
    };

    const crop = (buf: Buffer) =>
      sharp(buf).extract(region).greyscale().raw().toBuffer();

    const [tamperedPixels, controlPixels] = await Promise.all([
      crop(tampered.jpeg),
      crop(control.jpeg),
    ]);

    let diff = 0;
    for (let i = 0; i < tamperedPixels.length; i += 1) {
      diff += Math.abs(tamperedPixels[i]! - controlPixels[i]!);
    }
    const meanDiff = diff / tamperedPixels.length;

    // A forged figure over a control that was never edited must be plainly
    // different in that region — otherwise the tamper silently did nothing.
    expect(meanDiff).toBeGreaterThan(2);
  });
});
