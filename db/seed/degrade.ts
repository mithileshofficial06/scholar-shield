/**
 * Document realism pipeline (PROJECT_REPORT.md §7.2).
 *
 * OCR that reads cleanly-rendered images produced by the same script that will
 * grade it proves nothing — Tesseract on a pristine 900px canvas hits close to
 * 100% and says nothing about a phone photo of a scanned certificate. So no
 * document reaches the OCR stage without passing through here first.
 *
 * The stages mirror how a certificate actually arrives: it is printed, scanned
 * or photographed under uneven light, at a slight angle, and saved as a
 * mid-quality JPEG.
 *
 * DETERMINISM
 * -----------
 * Every random choice comes from a seeded PRNG keyed on the document reference,
 * never Math.random(). Regenerating the corpus must produce byte-identical
 * output, or the published ELA false-positive rate describes a corpus that no
 * longer exists.
 */

import sharp from 'sharp';

/** mulberry32 — small, fast, and good enough for jitter. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DegradeOptions {
  /** Keyed on the document reference so output is reproducible. */
  seed: string;
  /** Skip geometric distortion — used for the flat "scanner" profile. */
  flat?: boolean;
}

export interface DegradeResult {
  jpeg: Buffer;
  applied: {
    rotationDegrees: number;
    shear: number;
    illuminationStrength: number;
    noiseSigma: number;
    jpegQuality: number;
  };
}

function between(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Uneven illumination, as a diagonal gradient composited in multiply.
 *
 * A flatbed scanner produces a mild version of this; a phone photo produces a
 * strong one. Either way it is the single biggest reason OCR confidence drops
 * on real submissions, so it is not optional.
 */
function illuminationOverlay(width: number, height: number, strength: number, rng: () => number): Buffer {
  const angle = Math.round(between(rng, 0, 360));
  const dark = Math.round(255 * (1 - strength));
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
        <stop offset="0%" stop-color="rgb(255,255,255)"/>
        <stop offset="55%" stop-color="rgb(${dark + 18},${dark + 18},${dark + 14})"/>
        <stop offset="100%" stop-color="rgb(${dark},${dark},${dark - 4})"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`;
  return Buffer.from(svg);
}

/**
 * Sensor noise, generated from the seeded PRNG.
 *
 * sharp's own `noise: { type: 'gaussian' }` draws from libvips' internal random
 * source, which this module cannot seed — so using it made every regeneration
 * produce different bytes and quietly broke the reproducibility the corpus
 * depends on. Box–Muller over mulberry32 keeps it deterministic.
 *
 * Noise is monochrome and replicated across channels: real sensor noise at these
 * levels is dominated by the luminance component, and generating one value per
 * pixel instead of three keeps corpus generation fast.
 */
function gaussianNoise(
  width: number,
  height: number,
  sigma: number,
  rng: () => number,
): Buffer {
  const pixels = width * height;
  const buffer = Buffer.allocUnsafe(pixels * 3);

  for (let i = 0; i < pixels; i += 1) {
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const value = 128 + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
    const clamped = value < 0 ? 0 : value > 255 ? 255 : value;

    const offset = i * 3;
    buffer[offset] = clamped;
    buffer[offset + 1] = clamped;
    buffer[offset + 2] = clamped;
  }

  return buffer;
}

/**
 * Print → capture → save.
 *
 * Order matters and mirrors the physical chain: sensor noise and uneven light
 * happen at capture, geometry happens because the page was not square to the
 * lens, and JPEG compression happens last when the file is written. Compressing
 * first and rotating after would smear block artefacts in a way no real camera
 * produces — and would quietly corrupt the ELA signal the forensics stage reads.
 */
export async function degrade(input: Buffer, options: DegradeOptions): Promise<DegradeResult> {
  const rng = seededRandom(options.seed);

  const rotationDegrees = options.flat ? between(rng, -0.6, 0.6) : between(rng, -3, 3);
  const shear = options.flat ? 0 : between(rng, -0.02, 0.02);
  const illuminationStrength = options.flat ? between(rng, 0.04, 0.1) : between(rng, 0.12, 0.28);
  const noiseSigma = options.flat ? between(rng, 1.5, 4) : between(rng, 5, 11);
  const jpegQuality = Math.round(between(rng, 65, 85));

  const meta = await sharp(input).metadata();
  const width = meta.width ?? 900;
  const height = meta.height ?? 1180;

  // 1. Capture conditions: uneven light, then sensor noise.
  const lit = await sharp(input)
    .composite([
      { input: illuminationOverlay(width, height, illuminationStrength, rng), blend: 'multiply' },
    ])
    .png()
    .toBuffer();

  const noise = await sharp(gaussianNoise(width, height, noiseSigma, rng), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();

  const noisy = await sharp(lit)
    .composite([{ input: noise, blend: 'overlay' }])
    .png()
    .toBuffer();

  // 2. Geometry: the page was not square to the lens.
  let geometric = sharp(noisy).rotate(rotationDegrees, {
    background: { r: 246, g: 244, b: 238 },
  });

  if (shear !== 0) {
    geometric = geometric.affine([1, shear, 0, 1], {
      background: { r: 246, g: 244, b: 238 },
    });
  }

  // 3. Written to disk as a mid-quality JPEG.
  const jpeg = await geometric.jpeg({ quality: jpegQuality, mozjpeg: false }).toBuffer();

  return {
    jpeg,
    applied: { rotationDegrees, shear, illuminationStrength, noiseSigma, jpegQuality },
  };
}
