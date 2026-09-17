import { describe, expect, it } from 'vitest';

import { extensionFor, sniffContentType } from '../src/uploads.js';

/**
 * The upload gate decides what a file is from its bytes, because the declared
 * content type and the filename both come from whoever is uploading.
 */

const jpeg = (extra: number[] = []) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...extra]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webp = () =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 '),
  ]);
const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n');

describe('sniffContentType', () => {
  it('recognises the four accepted formats', () => {
    expect(sniffContentType(jpeg())).toBe('image/jpeg');
    expect(sniffContentType(png())).toBe('image/png');
    expect(sniffContentType(webp())).toBe('image/webp');
    expect(sniffContentType(pdf())).toBe('application/pdf');
  });

  it('rejects anything else', () => {
    expect(sniffContentType(Buffer.from('<?php system($_GET[0]); ?>'))).toBeNull();
    expect(sniffContentType(Buffer.from('PKzip'))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
    expect(sniffContentType(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG marker
  });

  it('does not accept a RIFF container that is not WebP', () => {
    const avi = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('AVI LIST'),
    ]);
    expect(sniffContentType(avi)).toBeNull();
  });

  it('will not let a PDF header hide deep inside another file', () => {
    // A polyglot: JPEG first, PDF header buried later. It is a JPEG, and the
    // %PDF- further in must not promote it.
    const polyglot = Buffer.concat([jpeg(), Buffer.alloc(64), Buffer.from('%PDF-1.4')]);
    expect(sniffContentType(polyglot)).toBe('image/jpeg');

    const notPdf = Buffer.concat([Buffer.alloc(200), Buffer.from('%PDF-1.4')]);
    expect(sniffContentType(notPdf)).toBeNull();
  });

  it('tolerates a BOM before a PDF header, as readers do', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4')]);
    expect(sniffContentType(withBom)).toBe('application/pdf');
  });
});

describe('extensionFor', () => {
  it('names a file after what it is, not what it was called', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/webp')).toBe('webp');
    expect(extensionFor('application/pdf')).toBe('pdf');
  });
});
