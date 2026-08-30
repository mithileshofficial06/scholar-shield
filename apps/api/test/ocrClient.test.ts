/**
 * The boundary with the Python service.
 *
 * Two things are worth testing here and neither needs a running service. First,
 * that snake_case is converted to camelCase exactly once, at this boundary — a
 * missed field arrives as `undefined` and reads downstream as "the certificate
 * says nothing here", which is a claim rather than a gap. Second, that failures
 * are classified as retryable or not, because the pipeline burns four attempts
 * and a dead-letter on anything misclassified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyze, extract, forensics, health, OcrServiceError } from '../src/pipeline/ocrClient.js';

const EXTRACTION_RESPONSE = {
  fields: {
    applicant_name: { value: 'Bhavani Shankar', confidence: 0.96, box: [300, 480, 520, 505] },
    annual_income: { value: 'Rs. 76,000/-', confidence: 0.94, box: [300, 700, 460, 730] },
    family_size: { value: null, confidence: 0.0, box: null },
  },
  skew_corrected_degrees: 1.5,
  page_confidence: 0.9413,
  word_count: 107,
  income_words_mismatch: false,
};

const FORENSICS_RESPONSE = {
  tamper_score: 0.153,
  regions: [{ box: [240, 480, 264, 504], z_score: 4.2, energy: 11.7 }],
  encoding: {
    format: 'JPEG',
    width: 953,
    height: 1203,
    quant_signature: 'a1b2c3d4e5f60718',
    estimated_quality: 78,
    has_exif: false,
    software_tags: [],
  },
  baseline_energy: 3.1,
  baseline_deviation: 1.4,
  notes: ['No EXIF metadata.'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const document = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('ocrClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('extract', () => {
    it('converts the wire format to camelCase', async () => {
      fetchMock.mockResolvedValue(jsonResponse(EXTRACTION_RESPONSE));

      const result = await extract(document, 'doc.jpg');

      expect(result.skewCorrectedDegrees).toBe(1.5);
      expect(result.pageConfidence).toBe(0.9413);
      expect(result.wordCount).toBe(107);
      expect(result.incomeWordsMismatch).toBe(false);
    });

    it('preserves a null value rather than coercing it to an empty string', async () => {
      fetchMock.mockResolvedValue(jsonResponse(EXTRACTION_RESPONSE));

      const result = await extract(document, 'doc.jpg');

      expect(result.fields.family_size?.value).toBeNull();
      expect(result.fields.family_size?.confidence).toBe(0);
      expect(result.fields.family_size?.box).toBeNull();
    });

    it('carries field boxes across as four-element tuples', async () => {
      fetchMock.mockResolvedValue(jsonResponse(EXTRACTION_RESPONSE));

      const result = await extract(document, 'doc.jpg');

      expect(result.fields.applicant_name?.box).toEqual([300, 480, 520, 505]);
    });

    it('posts the document as multipart form data', async () => {
      fetchMock.mockResolvedValue(jsonResponse(EXTRACTION_RESPONSE));

      await extract(document, 'doc.jpg');

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toMatch(/\/extract$/);
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
    });
  });

  describe('forensics', () => {
    it('converts the report and its nested encoding block', async () => {
      fetchMock.mockResolvedValue(jsonResponse(FORENSICS_RESPONSE));

      const result = await forensics(document, 'doc.jpg');

      expect(result.tamperScore).toBe(0.153);
      expect(result.baselineEnergy).toBe(3.1);
      expect(result.baselineDeviation).toBe(1.4);
      expect(result.encoding.quantSignature).toBe('a1b2c3d4e5f60718');
      expect(result.encoding.estimatedQuality).toBe(78);
      expect(result.encoding.hasExif).toBe(false);
    });

    it('converts region z-scores', async () => {
      fetchMock.mockResolvedValue(jsonResponse(FORENSICS_RESPONSE));

      const result = await forensics(document, 'doc.jpg');

      expect(result.regions[0]).toEqual({
        box: [240, 480, 264, 504],
        zScore: 4.2,
        energy: 11.7,
      });
    });

    it('defaults absent optional arrays rather than yielding undefined', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ...FORENSICS_RESPONSE, regions: undefined, notes: undefined }),
      );

      const result = await forensics(document, 'doc.jpg');

      expect(result.regions).toEqual([]);
      expect(result.notes).toEqual([]);
    });
  });

  describe('analyze', () => {
    it('returns both reports alongside the hash of the analysed bytes', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          sha256: 'abc123',
          byte_size: 72643,
          extraction: EXTRACTION_RESPONSE,
          forensics: FORENSICS_RESPONSE,
        }),
      );

      const result = await analyze(document, 'doc.jpg');

      expect(result.sha256).toBe('abc123');
      expect(result.byteSize).toBe(72643);
      expect(result.extraction.wordCount).toBe(107);
      expect(result.forensics.tamperScore).toBe(0.153);
    });
  });

  describe('failure classification', () => {
    it('treats an unreachable service as retryable', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const error = await extract(document, 'doc.jpg').catch((e) => e);

      expect(error).toBeInstanceOf(OcrServiceError);
      expect(error.retryable).toBe(true);
      expect(error.status).toBeNull();
    });

    it('treats a 5xx as retryable', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'boom' }, 503));

      const error = await extract(document, 'doc.jpg').catch((e) => e);

      expect(error.retryable).toBe(true);
      expect(error.status).toBe(503);
    });

    it('treats rate limiting as retryable', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'slow down' }, 429));

      const error = await extract(document, 'doc.jpg').catch((e) => e);

      expect(error.retryable).toBe(true);
    });

    it('treats an unreadable document as NOT retryable', async () => {
      // 415 is a property of the file. Retrying it four times only delays the
      // dead-letter by four attempts and burns an OCR pass each time.
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'Unsupported image.' }, 415));

      const error = await forensics(document, 'doc.jpg').catch((e) => e);

      expect(error.retryable).toBe(false);
      expect(error.status).toBe(415);
    });

    it('treats an oversized document as NOT retryable', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'too big' }, 413));

      const error = await forensics(document, 'doc.jpg').catch((e) => e);

      expect(error.retryable).toBe(false);
    });
  });

  describe('health', () => {
    it('reports a degraded service rather than throwing', async () => {
      // The service is up but cannot read a character. The pipeline needs to
      // know the difference, because it will otherwise keep feeding it.
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'degraded',
          tesseract_available: false,
          tesseract_version: null,
          tesseract_cmd: '/usr/bin/tesseract',
        }),
      );

      const result = await health();

      expect(result).toEqual({
        status: 'degraded',
        tesseractAvailable: false,
        tesseractVersion: null,
      });
    });

    it('returns null when the service cannot be reached', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await health()).toBeNull();
    });
  });
});
