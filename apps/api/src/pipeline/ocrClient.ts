/**
 * HTTP client for the Python OCR + forensics service.
 *
 * The service is stateless and knows nothing about applications, scores, or the
 * database — see apps/ocr-service/app/main.py. This module is the only place
 * that speaks to it, and the only place that converts its snake_case wire format
 * into the camelCase the rest of the API uses. Converting once, at the boundary,
 * keeps Python casing from leaking into serializers and the web app.
 *
 * FAILURE HANDLING
 * ----------------
 * The distinction that matters to the pipeline is retryable versus not. A
 * connection refused or a 5xx is the service being down — worth retrying, and
 * the stage runner will. A 415 on a file that is not an image is a property of
 * the document; retrying it four times just delays the dead-letter by four
 * attempts. `OcrServiceError.retryable` carries that distinction so the stage
 * handler does not have to parse messages.
 */

import { Blob } from 'node:buffer';

import { config } from '../config.js';

export class OcrServiceError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'OcrServiceError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ExtractedFieldPayload {
  value: string | null;
  confidence: number;
  box: [number, number, number, number] | null;
}

export interface ExtractionPayload {
  fields: Record<string, ExtractedFieldPayload>;
  skewCorrectedDegrees: number;
  pageConfidence: number;
  wordCount: number;
  incomeWordsMismatch: boolean | null;
}

export interface ElaRegionPayload {
  box: [number, number, number, number];
  zScore: number;
  energy: number;
}

export interface EncodingPayload {
  format: string;
  width: number;
  height: number;
  quantSignature: string | null;
  estimatedQuality: number | null;
  hasExif: boolean;
  softwareTags: string[];
}

export interface ForensicsPayload {
  tamperScore: number;
  regions: ElaRegionPayload[];
  encoding: EncodingPayload;
  baselineEnergy: number;
  baselineDeviation: number;
  notes: string[];
  /** False when ELA could not run (lossless image, vector PDF, too little print). */
  elaApplied: boolean;
}

export interface AnalyzePayload {
  sha256: string;
  byteSize: number;
  extraction: ExtractionPayload;
  forensics: ForensicsPayload;
}

export interface OcrHealth {
  status: 'ok' | 'degraded';
  tesseractAvailable: boolean;
  tesseractVersion: string | null;
}

/** Wall-clock budget for one document. OCR on a large scan is seconds, not ms. */
const REQUEST_TIMEOUT_MS = 60_000;

interface RawExtraction {
  fields: Record<string, { value: string | null; confidence: number; box: number[] | null }>;
  skew_corrected_degrees: number;
  page_confidence: number;
  word_count: number;
  income_words_mismatch: boolean | null;
}

interface RawForensics {
  tamper_score: number;
  regions: Array<{ box: number[]; z_score: number; energy: number }>;
  encoding: {
    format: string;
    width: number;
    height: number;
    quant_signature: string | null;
    estimated_quality: number | null;
    has_exif: boolean;
    software_tags: string[];
  };
  baseline_energy: number;
  baseline_deviation: number;
  notes: string[];
  ela_applied?: boolean;
}

function toBox(box: number[] | null): [number, number, number, number] | null {
  if (!box || box.length !== 4) return null;
  return [box[0]!, box[1]!, box[2]!, box[3]!];
}

function toExtraction(raw: RawExtraction): ExtractionPayload {
  const fields: Record<string, ExtractedFieldPayload> = {};
  for (const [name, field] of Object.entries(raw.fields ?? {})) {
    fields[name] = {
      value: field.value,
      confidence: field.confidence,
      box: toBox(field.box),
    };
  }
  return {
    fields,
    skewCorrectedDegrees: raw.skew_corrected_degrees,
    pageConfidence: raw.page_confidence,
    wordCount: raw.word_count,
    incomeWordsMismatch: raw.income_words_mismatch,
  };
}

function toForensics(raw: RawForensics): ForensicsPayload {
  return {
    tamperScore: raw.tamper_score,
    regions: (raw.regions ?? []).map((region) => ({
      box: toBox(region.box) ?? [0, 0, 0, 0],
      zScore: region.z_score,
      energy: region.energy,
    })),
    encoding: {
      format: raw.encoding.format,
      width: raw.encoding.width,
      height: raw.encoding.height,
      quantSignature: raw.encoding.quant_signature,
      estimatedQuality: raw.encoding.estimated_quality,
      hasExif: raw.encoding.has_exif,
      softwareTags: raw.encoding.software_tags ?? [],
    },
    baselineEnergy: raw.baseline_energy,
    baselineDeviation: raw.baseline_deviation,
    notes: raw.notes ?? [],
    // Absent from a service older than this field; every report it produced ran ELA or said otherwise in notes.
    elaApplied: raw.ela_applied ?? true,
  };
}

async function post<T>(path: string, document: Buffer, filename: string): Promise<T> {
  const form = new FormData();
  form.append('file', new Blob([document]), filename);

  let response: Response;
  try {
    response = await fetch(`${config.OCR_SERVICE_URL}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Connection refused, DNS failure, timeout — the service, not the document.
    const message = err instanceof Error ? err.message : String(err);
    throw new OcrServiceError(`OCR service unreachable: ${message}`, null, true);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 4xx is the document's fault and will fail identically on every retry.
    // 5xx and 429 are the service's, and are worth another attempt.
    const retryable = response.status >= 500 || response.status === 429;
    throw new OcrServiceError(
      `OCR service returned ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      retryable,
    );
  }

  return (await response.json()) as T;
}

export async function extract(
  document: Buffer,
  filename: string,
): Promise<ExtractionPayload> {
  return toExtraction(await post<RawExtraction>('/extract', document, filename));
}

export async function forensics(
  document: Buffer,
  filename: string,
): Promise<ForensicsPayload> {
  return toForensics(await post<RawForensics>('/forensics', document, filename));
}

export async function analyze(
  document: Buffer,
  filename: string,
): Promise<AnalyzePayload> {
  const raw = await post<{
    sha256: string;
    byte_size: number;
    extraction: RawExtraction;
    forensics: RawForensics;
  }>('/analyze', document, filename);

  return {
    sha256: raw.sha256,
    byteSize: raw.byte_size,
    extraction: toExtraction(raw.extraction),
    forensics: toForensics(raw.forensics),
  };
}

/**
 * Used by /health on the API. Reports `degraded` rather than throwing when the
 * service is up but Tesseract is missing — a distinction that matters, because
 * the pipeline will happily keep feeding a service that can read nothing.
 */
export async function health(): Promise<OcrHealth | null> {
  try {
    const response = await fetch(`${config.OCR_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;

    const raw = (await response.json()) as {
      status: 'ok' | 'degraded';
      tesseract_available: boolean;
      tesseract_version: string | null;
    };
    return {
      status: raw.status,
      tesseractAvailable: raw.tesseract_available,
      tesseractVersion: raw.tesseract_version,
    };
  } catch {
    return null;
  }
}
