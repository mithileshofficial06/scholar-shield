"""
Wire contract between this service and apps/api.

These shapes are mirrored in `packages/shared/src/index.ts` (DocumentSummary
.extractedFields, .tamperScore) and consumed by `apps/api/src/pipeline`. The
field names here are snake_case; the TypeScript client converts once, at the
boundary, rather than leaking Python casing through the API.

DESIGN NOTE — WHY EVERY FIELD CARRIES A CONFIDENCE
--------------------------------------------------
An OCR result with no confidence forces every downstream consumer to treat a
guess and a certainty identically. The household engine already declines to
merge on weak evidence; it can only do that if the evidence arrives labelled.
A field that could not be read is `null` with confidence 0 — never an empty
string, which reads downstream as "the certificate says nothing here".
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

FieldName = Literal[
    "applicant_name",
    "guardian_name",
    "address",
    "district",
    "pincode",
    "family_size",
    "annual_income",
    "annual_income_words",
    "certificate_id",
    "issue_date",
    "issuing_office",
]


class ExtractedField(BaseModel):
    """One label-anchored field lifted off the certificate."""

    value: str | None = None
    # Tesseract's own word confidence, averaged over the tokens that formed the
    # value and rescaled to 0-1. Not a probability of correctness — a measure of
    # how sure the recogniser was about the glyphs.
    confidence: float = Field(ge=0.0, le=1.0, default=0.0)
    # Where it was found on the deskewed page, for the reviewer's overlay.
    box: tuple[int, int, int, int] | None = None


class ExtractionReport(BaseModel):
    fields: dict[str, ExtractedField]
    # Positive = the page was rotated clockwise and had to be turned back.
    skew_corrected_degrees: float
    # Mean word confidence across the whole page. A low value here with high
    # per-field confidence usually means the watermark and seal are being read
    # as text, which is expected and harmless.
    page_confidence: float
    word_count: int
    # True when the figure and the amount-in-words disagree after parsing.
    # See the honest caveat in forensics.py / the service README: the corpus's
    # tamper path rewrites BOTH, so this fires zero times on it by construction.
    income_words_mismatch: bool | None = None


class EncodingReport(BaseModel):
    """What the file itself says about its own history."""

    format: str
    width: int
    height: int
    # JPEG quantization tables hash. Two documents from the same camera and
    # pipeline share one; a re-encode by a different tool changes it.
    quant_signature: str | None = None
    estimated_quality: int | None = None
    has_exif: bool = False
    # EXIF Software / Processing tags, when present. A certificate whose
    # metadata names an image editor is worth a reviewer's attention; a
    # certificate with no metadata at all is the norm and means nothing.
    software_tags: list[str] = Field(default_factory=list)


class ElaRegion(BaseModel):
    box: tuple[int, int, int, int]
    # How far this block's ELA energy sits above the page's own baseline,
    # in robust standard deviations (median / MAD). Unitless by design: an
    # absolute ELA value is meaningless across different capture qualities.
    z_score: float
    energy: float


class ForensicsReport(BaseModel):
    # 0-1. NOT a probability that the document is forged. It is a normalized
    # measure of how anomalous the strongest local re-compression signature is
    # relative to the rest of the same page. Tier 2 weight is deliberately low
    # (PROJECT_REPORT.md §5) and no rule promotes it to high severity alone.
    tamper_score: float = Field(ge=0.0, le=1.0)
    regions: list[ElaRegion]
    encoding: EncodingReport
    # Baseline statistics, published so a reviewer can see the score's denominator.
    baseline_energy: float
    baseline_deviation: float
    notes: list[str] = Field(default_factory=list)
    # False when error level analysis could not run at all (a lossless format, a
    # vector PDF, too little print). A tamper_score of 0 is then "not measured",
    # not "clean" — and the two must not look the same to a reviewer.
    ela_applied: bool = True


class AnalyzeResponse(BaseModel):
    sha256: str
    byte_size: int
    extraction: ExtractionReport
    forensics: ForensicsReport


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    tesseract_available: bool
    tesseract_version: str | None = None
    tesseract_cmd: str
