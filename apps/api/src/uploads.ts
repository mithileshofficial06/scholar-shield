/**
 * What an upload actually is, as opposed to what it claims to be.
 *
 * `Content-Type` on a multipart part is supplied by the client, and the file
 * extension is supplied by the client too. Neither is evidence. A polyglot file
 * — valid PDF header, valid image tail, something else entirely in the middle —
 * is the standard trick against a pipeline that dispatches on the declared type
 * (PROJECT_REPORT.md §11).
 *
 * So the type is decided by the bytes, and only four formats are accepted. The
 * decision is also what gets stored, so every later consumer (the OCR service,
 * the signed-URL response) describes the file the same way.
 *
 * This is a gate, not a security boundary. The boundary is that parsing happens
 * in the isolated Python service, which holds no database credentials.
 */

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Returns the media type the bytes are, or null when they are none of the four.
 *
 * Null means reject: an unrecognised file is never passed along on the strength
 * of its filename.
 */
export function sniffContentType(buffer: Buffer): SniffedType | null {
  // JPEG: SOI marker.
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: signature includes \r\n and ^Z so that broken transfers corrupt it.
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // WebP: 'RIFF' .... 'WEBP' — both halves must match, or a RIFF container of
  // some other kind (an AVI, say) would pass.
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }

  // PDF: %PDF-. Allowed to appear slightly inside the file, because some
  // producers emit a UTF-8 BOM or stray whitespace first, and readers accept it.
  const head = buffer.subarray(0, 1024).indexOf('%PDF-');
  if (head !== -1 && head <= 4) return 'application/pdf';

  return null;
}

/** File extension for a sniffed type. Never taken from the uploaded filename. */
export function extensionFor(type: SniffedType): string {
  switch (type) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
  }
}
