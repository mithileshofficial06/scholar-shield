/**
 * Tamper generation, decoupled from tamper detection (PROJECT_REPORT.md §7.3).
 *
 * THE POINT OF THIS FILE
 * ----------------------
 * ELA finds regions whose JPEG compression history differs from their
 * surroundings. If tampered documents were produced with the same library and
 * the same single re-save that the detector implicitly assumes, ELA would find
 * them trivially and the resulting recall figure would measure nothing but the
 * generator agreeing with itself.
 *
 * Two things prevent that:
 *
 *   1. THE TAMPER USES A DIFFERENT IMAGE PATH. Rendering and degradation go
 *      through sharp (libvips). The edit itself is decoded, composited, and
 *      re-encoded through @napi-rs/canvas (Skia) — a different decoder, a
 *      different JPEG encoder, different chroma handling. The forger is not
 *      using the analyst's toolchain, which is also true in reality.
 *
 *   2. THERE IS A CONTROL GROUP. For every tampered document, an untampered one
 *      goes through the identical number of decode/re-encode cycles at identical
 *      qualities. The ONLY difference is whether a region was painted.
 *
 * Without the control group, "ELA flagged 90% of tampered documents" is
 * unfalsifiable — it could flag 90% of everything. The control group is what
 * turns the ELA false-positive rate from a disclaimer into a measured number.
 *
 * ORDERING: TAMPER BEFORE DEGRADATION
 * -----------------------------------
 * These functions take the freshly rendered PNG, not a degraded JPEG, and the
 * caller degrades the result afterwards. Two reasons, one practical and one
 * about honesty:
 *
 *   - The field boxes come from the renderer, in un-rotated coordinates.
 *     Degradation rotates and shears the page, so painting onto an
 *     already-degraded image lands the patch in the wrong place. That is a bug
 *     this file had, and it was visible: a fragment of the original figure
 *     survived beside the forged one.
 *
 *   - It matches the physical chain. A certificate is printed, then scanned or
 *     photographed, and the forger edits and re-saves whatever they were given.
 *     Degrading last means the final save re-compresses the whole page uniformly
 *     ON TOP of the edit, which partially masks the local artefact. That makes
 *     ELA's job harder, not easier — which is the entire point of §7.3. The
 *     control receives the identical treatment, so the comparison stays fair.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { FieldBox } from './certificate.js';
import { amountInWords, formatINR } from './certificate.js';
import { seededRandom } from './degrade.js';

/** Compression history shared by tampered documents and their controls. */
export const COMPRESSION_CHAIN = [92, 88] as const;

export interface TamperEdit {
  /** Value visible on the rendered document before the edit. */
  originalIncome: number;
  /** Value painted over it. */
  forgedIncome: number;
  incomeBox: FieldBox;
  incomeWordsBox: FieldBox;
}

export interface TamperResult {
  jpeg: Buffer;
  /** Null for control documents. */
  edit: TamperEdit | null;
  compressionChain: readonly number[];
}

async function reencode(input: Buffer, quality: number): Promise<Buffer> {
  const image = await loadImage(input);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  // Skia's JPEG encoder, not libvips'. Quality here is 0-100, NOT 0-1 — passing
  // a fraction clamps to the floor and produces a ruined image rather than an
  // error, which is exactly how it slipped through the first time.
  return canvas.toBuffer('image/jpeg', quality);
}

/**
 * Paint a replacement income over the rendered one.
 *
 * The patch is filled with the sampled paper colour rather than pure white, and
 * the replacement text is drawn in the same face and size as the original. A
 * forgery that leaves a white rectangle is caught by looking at it, and proves
 * nothing about the detector.
 */
async function paintForgedIncome(
  input: Buffer,
  edit: Omit<TamperEdit, 'incomeWordsBox'> & { incomeWordsBox: FieldBox },
  seed: string,
): Promise<Buffer> {
  const rng = seededRandom(`${seed}:paint`);
  const image = await loadImage(input);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  // Sample the paper a little above the field so the patch matches the page,
  // including whatever illumination gradient degradation already applied.
  const sample = ctx.getImageData(
    Math.max(0, Math.round(edit.incomeBox.x + 4)),
    Math.max(0, Math.round(edit.incomeBox.y - 12)),
    1,
    1,
  ).data;
  const paper = `rgb(${sample[0]},${sample[1]},${sample[2]})`;

  const patch = (box: FieldBox) => {
    ctx.fillStyle = paper;
    // Slight jitter on the patch bounds — a forger does not select pixel-exact
    // rectangles, and an exactly-aligned patch is an artefact of the generator.
    ctx.fillRect(
      box.x - 2 + rng() * 2,
      box.y - 2 + rng() * 2,
      box.width + 4 + rng() * 3,
      box.height + 4,
    );
  };

  patch(edit.incomeBox);
  patch(edit.incomeWordsBox);

  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 20px Arial';
  ctx.fillText(
    `Rs. ${formatINR(edit.forgedIncome)}/-`,
    edit.incomeBox.x + 4,
    edit.incomeBox.y + 22,
  );

  ctx.font = 'italic 13px Arial';
  ctx.fillText(
    amountInWords(edit.forgedIncome),
    edit.incomeWordsBox.x + 4,
    edit.incomeWordsBox.y + 15,
  );

  return canvas.toBuffer('image/jpeg', COMPRESSION_CHAIN[1]);
}

/**
 * Produce a tampered document: encode, decode, paint a forged income, re-encode.
 * The painted region has one more encode cycle than its surroundings, which is
 * exactly the local inconsistency ELA is designed to surface.
 */
export async function tamper(
  renderedPng: Buffer,
  params: {
    seed: string;
    originalIncome: number;
    forgedIncome: number;
    incomeBox: FieldBox;
    incomeWordsBox: FieldBox;
  },
): Promise<TamperResult> {
  const firstPass = await reencode(renderedPng, COMPRESSION_CHAIN[0]);

  const edit: TamperEdit = {
    originalIncome: params.originalIncome,
    forgedIncome: params.forgedIncome,
    incomeBox: params.incomeBox,
    incomeWordsBox: params.incomeWordsBox,
  };

  const jpeg = await paintForgedIncome(firstPass, edit, params.seed);

  return { jpeg, edit, compressionChain: COMPRESSION_CHAIN };
}

/**
 * The control: identical compression history, nothing painted.
 *
 * Any ELA response here is a false positive by construction, because nothing was
 * altered. This is the denominator of the published false-positive rate.
 */
export async function recompressControl(renderedPng: Buffer): Promise<TamperResult> {
  const firstPass = await reencode(renderedPng, COMPRESSION_CHAIN[0]);
  const jpeg = await reencode(firstPass, COMPRESSION_CHAIN[1]);

  return { jpeg, edit: null, compressionChain: COMPRESSION_CHAIN };
}
