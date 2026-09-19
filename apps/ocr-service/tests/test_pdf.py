"""
PDF uploads.

The API has always accepted PDF certificates and this service refused every one
of them, which dead-lettered the document and kept its application out of the
review queue for good. These tests pin both halves of the fix: a PDF is read,
and forensics is honest about what it can and cannot measure in one.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import forensics, pdf
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def page_image(size=(850, 1100)) -> Image.Image:
    """A page with enough printed texture for ELA to have a baseline."""
    image = Image.new("RGB", size, (251, 250, 246))
    draw = ImageDraw.Draw(image)
    for row in range(60, size[1] - 60, 22):
        for col in range(60, size[0] - 60, 90):
            draw.text((col, row), "Rs 1,80,000", fill=(30, 30, 30))
    return image


def scanned_pdf(pages: int = 1, **info: str) -> bytes:
    """A scan-style PDF. Pillow embeds an RGB page as a DCTDecode (JPEG) stream."""
    images = [page_image() for _ in range(pages)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:], resolution=100, **info)
    return buffer.getvalue()


def vector_pdf() -> bytes:
    """A one-page PDF of real text and no image — what a document tool exports."""
    content = b"BT /F1 18 Tf 72 700 Td (Annual Family Income Rs. 1,80,000) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n%s\nendobj\n" % (number, body))
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return out.getvalue()


class TestReading:
    def test_recognises_a_pdf_by_its_header(self):
        assert pdf.is_pdf(scanned_pdf())
        assert pdf.is_pdf(b"\xef\xbb\xbf" + vector_pdf())
        assert not pdf.is_pdf(b"\xff\xd8\xff\xe0 not a pdf")

    def test_renders_the_first_page_for_ocr(self):
        content = pdf.read(scanned_pdf())
        assert content.page.mode == "RGB"
        # 200 DPI render of an 8.5x11in page.
        assert content.page.width == pytest.approx(1700, abs=4)
        assert content.page_count == 1

    def test_finds_the_embedded_scan_of_a_scanned_pdf(self):
        content = pdf.read(scanned_pdf())
        assert content.scan_jpeg is not None
        assert content.scan_jpeg[:3] == b"\xff\xd8\xff"

    def test_a_vector_pdf_has_no_scan(self):
        assert pdf.read(vector_pdf()).scan_jpeg is None

    def test_reads_producer_and_creator(self):
        content = pdf.read(scanned_pdf(producer="Photo Editor Pro", creator="Scanner App"))
        assert content.producer == "Photo Editor Pro"
        assert content.creator == "Scanner App"

    def test_says_when_later_pages_were_not_read(self):
        content = pdf.read(scanned_pdf(pages=3))
        assert content.page_count == 3
        assert any("3 pages" in note for note in content.notes)

    def test_refuses_a_file_that_only_claims_to_be_a_pdf(self):
        with pytest.raises(pdf.PdfError):
            pdf.read(b"%PDF-1.4\nthis is not a pdf at all")


class TestForensics:
    def test_runs_ela_on_the_embedded_scan(self, settings):
        report = forensics.analyze_pdf(pdf.read(scanned_pdf()), settings)
        assert report.ela_applied is True
        assert report.encoding.format == "JPEG"
        assert any("embedded in the PDF" in note for note in report.notes)

    def test_does_not_pretend_to_measure_a_vector_pdf(self, settings):
        report = forensics.analyze_pdf(pdf.read(vector_pdf()), settings)
        assert report.ela_applied is False
        assert report.tamper_score == 0.0
        assert report.encoding.format == "PDF"

    def test_reports_the_writing_software_as_metadata(self, settings):
        report = forensics.analyze_pdf(pdf.read(scanned_pdf(producer="Photo Editor Pro")), settings)
        assert "Photo Editor Pro" in report.encoding.software_tags


class TestEndpoints:
    """The endpoints the API's pipeline calls, which used to answer 415 to any PDF."""

    @pytest.mark.parametrize("path", ["/extract", "/forensics", "/analyze"])
    def test_accepts_a_pdf(self, client, path, requires_tesseract):
        response = client.post(path, files={"file": ("cert.pdf", scanned_pdf(), "application/pdf")})
        assert response.status_code == 200, response.text

    def test_refuses_a_corrupt_pdf_with_415(self, client):
        response = client.post("/extract", files={"file": ("x.pdf", b"%PDF-1.4 junk", "application/pdf")})
        assert response.status_code == 415

    def test_marks_lossless_images_as_not_measured(self, client):
        buffer = io.BytesIO()
        page_image().save(buffer, format="PNG")
        report = client.post("/forensics", files={"file": ("c.png", buffer.getvalue(), "image/png")}).json()
        assert report["ela_applied"] is False
