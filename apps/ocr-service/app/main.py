"""
OCR + forensics service (PROJECT_REPORT.md §10, Week 4).

A separate process, in a separate language, for one reason that matters: it is
where untrusted uploads get parsed. Tesseract and Pillow are large C surfaces
being pointed at files a stranger supplied, so they run here — isolated, with no
database credentials and no ability to write anything — rather than inside the
API that holds the session keys. The threat-model row for malicious uploads in
§11 is only true because of that separation.

The service is deliberately stateless: bytes in, report out. It never stores a
document, never learns which application a document belongs to, and has no
concept of a risk score. Scoring is the API's job, and keeping the judgement out
of here is what stops a forensics signal from quietly becoming a verdict.
"""

from __future__ import annotations

import hashlib
import io
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from . import forensics, ocr, pdf
from .config import get_settings
from .models import AnalyzeResponse, ExtractionReport, ForensicsReport, HealthResponse

logger = logging.getLogger("ocr-service")

# Pillow refuses images above this pixel count as a decompression-bomb guard.
# A certificate scanned at 600dpi is ~35MP; this leaves headroom above that and
# still rejects a file crafted to exhaust memory.
Image.MAX_IMAGE_PIXELS = 80_000_000

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
    if not settings.tesseract_available:
        # Not fatal: /health reports it, and the API's stage handler can mark
        # the stage failed rather than the whole service refusing to start. A
        # crash loop is harder to diagnose than a degraded health check.
        logger.warning(
            "Tesseract not found at %s — extraction will fail until it is "
            "installed or OCR_TESSERACT_CMD is set.",
            settings.tesseract_cmd,
        )
    yield


app = FastAPI(
    title="ScholarShield OCR & Forensics",
    version="0.1.0",
    description=(
        "Stateless extraction and document forensics. Returns signals, never "
        "decisions."
    ),
    lifespan=lifespan,
)


def _load_image(raw: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except UnidentifiedImageError:
        raise HTTPException(status_code=415, detail="Unsupported or corrupt image.")
    except Image.DecompressionBombError:
        raise HTTPException(status_code=413, detail="Image dimensions too large.")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not read image: {exc}")
    return image


def _page_image(raw: bytes) -> Image.Image:
    """What OCR reads: the image itself, or the first page of a PDF rendered."""
    if pdf.is_pdf(raw):
        return _read_pdf(raw).page
    return _load_image(raw)


def _read_pdf(raw: bytes) -> pdf.PdfContent:
    try:
        return pdf.read(raw)
    except pdf.PdfError as exc:
        raise HTTPException(status_code=415, detail=str(exc))


def _forensics(raw: bytes) -> ForensicsReport:
    settings = get_settings()
    if pdf.is_pdf(raw):
        return forensics.analyze_pdf(_read_pdf(raw), settings)
    return forensics.analyze(_load_image(raw), raw, settings)


def _read_upload(upload: UploadFile) -> bytes:
    settings = get_settings()
    # The underlying spooled file, read synchronously: this runs on a worker
    # thread (see the note on the endpoints below), not on the event loop.
    raw = upload.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds {settings.max_upload_bytes} bytes.",
        )
    return raw


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """
    Reports whether Tesseract actually resolved, not merely that the process is
    up. A service that answers 200 while unable to read a single character is
    worse than one that is down, because the pipeline keeps feeding it.
    """
    settings = get_settings()
    version: str | None = None
    if settings.tesseract_available:
        try:
            version = str(pytesseract.get_tesseract_version())
        except Exception:  # pragma: no cover - environment dependent
            version = None

    return HealthResponse(
        status="ok" if version else "degraded",
        tesseract_available=settings.tesseract_available,
        tesseract_version=version,
        tesseract_cmd=settings.tesseract_cmd,
    )


# The endpoints below are plain `def`, not `async def`, on purpose. Tesseract,
# Pillow and NumPy are blocking CPU work; inside an `async def` they ran on the
# event loop itself, so while one certificate was being read the service could
# not answer anything else — including /health, whose 5-second probe then
# failed and marked a busy service unhealthy. FastAPI runs a `def` endpoint on
# its threadpool, which keeps the loop free.


@app.post("/extract", response_model=ExtractionReport)
def extract(file: UploadFile = File(...)) -> ExtractionReport:
    """Field extraction only. Separate from /forensics so the API's pipeline can
    retry one stage without paying for the other."""
    raw = _read_upload(file)
    return ocr.analyze(_page_image(raw), get_settings())


@app.post("/forensics", response_model=ForensicsReport)
def analyze_forensics(file: UploadFile = File(...)) -> ForensicsReport:
    raw = _read_upload(file)
    return _forensics(raw)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(file: UploadFile = File(...)) -> AnalyzeResponse:
    """
    Both stages in one call.

    The sha256 is returned so the API can confirm the bytes analysed are the
    bytes it stored. It survives document purge in the audit trail (§10
    retention), which means a decision stays traceable to a specific file after
    that file is gone.
    """
    raw = _read_upload(file)

    return AnalyzeResponse(
        sha256=hashlib.sha256(raw).hexdigest(),
        byte_size=len(raw),
        extraction=ocr.analyze(_page_image(raw), get_settings()),
        forensics=_forensics(raw),
    )
