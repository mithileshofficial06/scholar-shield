"""
PDF uploads.

The API accepts a PDF certificate, and this service used to open every upload
with Pillow, which cannot read one — so a PDF failed extraction on every retry,
was dead-lettered, and its application never reached a reviewer.

WHAT A PDF CERTIFICATE USUALLY IS
---------------------------------
Almost always one of two things: a scan (one page, one embedded photograph of
the paper) or an export from a document tool (vector text, no image). The two
need different handling, and only the first carries a compression history.

  - OCR reads a render of the first page, whichever kind it is. Text in a
    vector PDF could be pulled out directly, but reading the render keeps one
    extraction path for every format, so accuracy measured on images holds here.
  - Forensics runs error level analysis on the *embedded* JPEG when the page is
    a single scan, because that is the only pixel data with a compression
    history of its own. A render is freshly rasterised, so ELA on it would
    measure the renderer. For anything else ELA does not apply, and the report
    says so instead of scoring.
  - The PDF's Producer and Creator are reported as metadata. Unlike EXIF, a PDF
    names the tool that wrote it, and a certificate saved by an image editor or
    an online PDF editor is worth a reviewer's glance.

Only the first page is read: an income certificate is one page, and rendering
an arbitrary page count is an unbounded amount of work on untrusted input.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

# Render resolution. Tesseract is tuned for roughly 300 DPI text; 200 keeps an
# A4 page near the pixel size of the corpus images without the memory of 300.
_RENDER_DPI = 200

# Refuse pages whose render would exceed this many pixels — the PDF equivalent
# of Pillow's decompression-bomb guard. A4 at 200 DPI is about 3.9 million.
_MAX_RENDER_PIXELS = 40_000_000

# An embedded image counts as "the scan" only if it covers most of the page;
# a logo or a seal must not be mistaken for the document.
_SCAN_COVERAGE = 0.6


class PdfError(ValueError):
    """The upload claims to be a PDF but cannot be read as one."""


@dataclass
class PdfContent:
    page: Image.Image
    page_count: int
    producer: str | None
    creator: str | None
    #: JPEG bytes of the single full-page scan, when the page is one.
    scan_jpeg: bytes | None
    notes: list[str] = field(default_factory=list)


def is_pdf(raw: bytes) -> bool:
    """Same rule as the API's upload sniffing: the header near the start."""
    return b"%PDF-" in raw[:1024]


def read(raw: bytes) -> PdfContent:
    try:
        document = pdfium.PdfDocument(raw)
    except pdfium.PdfiumError as exc:
        raise PdfError(f"Unreadable PDF: {exc}") from exc

    try:
        page_count = len(document)
        if page_count == 0:
            raise PdfError("The PDF has no pages.")

        metadata = document.get_metadata_dict(skip_empty=True)
        page = document[0]
        width, height = page.get_size()
        scale = _RENDER_DPI / 72.0
        if width * height * scale * scale > _MAX_RENDER_PIXELS:
            raise PdfError("The PDF page is too large to render.")

        image = page.render(scale=scale).to_pil().convert("RGB")
        scan = _single_scan_jpeg(page, width * height)

        notes: list[str] = []
        if page_count > 1:
            notes.append(f"The PDF has {page_count} pages; only the first was read.")

        return PdfContent(
            page=image,
            page_count=page_count,
            producer=metadata.get("Producer"),
            creator=metadata.get("Creator"),
            scan_jpeg=scan,
            notes=notes,
        )
    finally:
        document.close()


def _single_scan_jpeg(page: pdfium.PdfPage, page_area: float) -> bytes | None:
    """The page's one full-page JPEG, extracted without re-encoding, if it has one."""
    images = list(page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE]))
    if len(images) != 1:
        return None

    image = images[0]
    left, bottom, right, top = image.get_pos()
    if (right - left) * (top - bottom) < _SCAN_COVERAGE * page_area:
        return None
    # Only a DCT stream is the original JPEG. Anything else would be decoded and
    # re-encoded by the extractor, giving it a fresh compression history that ELA
    # would read as uniform — a clean result the document never earned.
    if image.get_filters() != ["DCTDecode"]:
        return None

    buffer = io.BytesIO()
    image.extract(buffer)
    return buffer.getvalue()
