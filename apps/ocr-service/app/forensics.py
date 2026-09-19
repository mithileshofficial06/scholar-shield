"""
Document forensics — Error Level Analysis and encoding metadata.

WHAT ELA ACTUALLY MEASURES
--------------------------
Re-saving a JPEG at a fixed quality and differencing against the original shows
how much each region still had to lose. A region that has been decoded, edited,
and re-encoded has a different compression history from its surroundings, so it
gives up a different amount — and shows up as a local anomaly.

It measures *inconsistent compression history*, not dishonesty. Every caveat
below follows from that one sentence, and the Tier 2 weight in
PROJECT_REPORT.md §5 is low because of it.

WHY THE SCORE IS RELATIVE TO THE PAGE, NOT ABSOLUTE
---------------------------------------------------
Absolute ELA energy is dominated by capture quality: a quality-65 phone photo
has more of it everywhere than a quality-85 scan, and thresholding on the raw
value ranks documents by how they were photographed. So each block is scored
against the same page's own baseline, in robust standard deviations (median and
MAD, not mean and sigma — a tampered region is exactly the kind of outlier that
would inflate a mean-based baseline and hide itself).

WHY ONLY INKED BLOCKS ARE SCORED
--------------------------------
Blank paper compresses to nothing and re-compresses to nothing, so its ELA
energy is near zero. Including it drags the median down and makes every text
block look anomalous. Worse, degradation rotates the page and fills the corners
with flat colour, so the blank fraction varies per document — the baseline would
then depend on rotation angle. Blocks are scored only where there is ink to
have a compression history at all.

HONEST LIMITS
-------------
ELA is weak evidence, and this corpus is deliberately hostile to it: the tamper
path re-encodes through Skia while the rest of the pipeline uses libvips, and
degradation then re-compresses the whole page ON TOP of the edit, partially
masking the local artefact (see db/seed/tamper.ts). The measured separation
between tampered and control documents is reported by
`apps/api/scripts/metrics.ts`, not asserted here. Whatever it turns out to be is
the number this project publishes.
"""

from __future__ import annotations

import hashlib
import io

import numpy as np
from PIL import Image

from .config import Settings
from .models import ElaRegion, EncodingReport, ForensicsReport
from .pdf import PdfContent

# Blocks below this mean gradient carry no ink worth scoring. In 0-255 units of
# local contrast, chosen so flat paper and rotation fill are excluded while the
# lightest printed text is kept.
_INK_THRESHOLD = 6.0

# MAD-to-sigma conversion for a normal distribution.
_MAD_TO_SIGMA = 1.4826

# A z-score at or above this is reported as a region of interest. Not a verdict —
# it is what the reviewer's heatmap draws a box around.
_REGION_Z = 3.5

# z-score mapped to tamper_score 1.0. Above this the signal is saturated and
# further separation carries no extra meaning.
_SATURATION_Z = 12.0

# Fewer inked blocks than this and the baseline is not estimable.
_MIN_INKED_BLOCKS = 24


def _ela_map(image: Image.Image, quality: int) -> np.ndarray:
    """Per-pixel absolute difference between the image and its own re-encode."""
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    resaved = Image.open(buffer).convert("RGB")

    original = np.asarray(image.convert("RGB"), dtype=np.int16)
    again = np.asarray(resaved, dtype=np.int16)
    # Max across channels, not mean: chroma subsampling makes a repainted
    # region diverge on one channel more than the others, and averaging
    # dilutes exactly the signal being looked for.
    return np.abs(original - again).max(axis=2).astype(np.float32)


def _ink_map(image: Image.Image) -> np.ndarray:
    """Local gradient magnitude — a cheap stand-in for "is there print here"."""
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    dy = np.zeros_like(gray)
    dx = np.zeros_like(gray)
    dy[:-1, :] = np.abs(np.diff(gray, axis=0))
    dx[:, :-1] = np.abs(np.diff(gray, axis=1))
    return dx + dy


def _block_reduce(array: np.ndarray, block: int) -> np.ndarray:
    """Mean of each block x block tile, trimming any partial edge tiles."""
    height = (array.shape[0] // block) * block
    width = (array.shape[1] // block) * block
    if height == 0 or width == 0:
        return np.zeros((0, 0), dtype=np.float32)
    trimmed = array[:height, :width]
    return trimmed.reshape(
        height // block, block, width // block, block
    ).mean(axis=(1, 3))


def _estimate_quality(quantization: dict[int, list[int]] | None) -> int | None:
    """
    Approximate JPEG quality from the luminance quantization table.

    Uses the standard IJG table as reference: the encoder scales it by a factor
    derived from the quality setting, so comparing the sum of the table against
    the sum of the reference recovers that factor. Approximate by nature —
    reported so a reviewer can see that two documents were saved differently,
    never used as a threshold.
    """
    if not quantization or 0 not in quantization:
        return None

    standard_luminance_sum = 1_260  # sum of the IJG baseline luminance table
    table = list(quantization[0])
    if not table:
        return None

    total = float(sum(table))
    if total <= 0:
        return None

    scale = total / standard_luminance_sum * 100.0
    quality = (200.0 - scale) / 2.0 if scale >= 100.0 else 5_000.0 / max(scale, 1e-6)
    return int(max(1, min(100, round(quality))))


def read_encoding(image: Image.Image, raw: bytes) -> EncodingReport:
    quantization = getattr(image, "quantization", None)

    signature = None
    if quantization:
        flat = ",".join(
            f"{key}:{'.'.join(str(v) for v in values)}"
            for key, values in sorted(quantization.items())
        )
        signature = hashlib.sha256(flat.encode()).hexdigest()[:16]

    software_tags: list[str] = []
    has_exif = False
    try:
        exif = image.getexif()
        if exif:
            has_exif = True
            # 305 = Software, 11 = ProcessingSoftware, 272 = Model.
            for tag in (305, 11, 272):
                value = exif.get(tag)
                if value:
                    software_tags.append(str(value).strip())
    except Exception:
        # A malformed EXIF block is a property of the upload, not an error the
        # pipeline should fail on. Absent metadata is the normal case anyway.
        has_exif = False

    return EncodingReport(
        format=image.format or "UNKNOWN",
        width=image.width,
        height=image.height,
        quant_signature=signature,
        estimated_quality=_estimate_quality(quantization),
        has_exif=has_exif,
        software_tags=software_tags,
    )


def analyze(image: Image.Image, raw: bytes, settings: Settings) -> ForensicsReport:
    encoding = read_encoding(image, raw)
    notes: list[str] = []

    if encoding.format != "JPEG":
        # ELA on a lossless format compares an image against its FIRST lossy
        # encode, so the whole page reads as anomalous and the score is
        # meaningless. Say so rather than return a number that looks like one.
        notes.append(
            f"{encoding.format} is not a lossy format; error level analysis "
            "does not apply and no tamper score was computed."
        )
        return ForensicsReport(
            ela_applied=False,
            tamper_score=0.0,
            regions=[],
            encoding=encoding,
            baseline_energy=0.0,
            baseline_deviation=0.0,
            notes=notes,
        )

    block = settings.ela_block_size
    ela_blocks = _block_reduce(_ela_map(image, settings.ela_quality), block)
    ink_blocks = _block_reduce(_ink_map(image), block)

    inked = ink_blocks >= _INK_THRESHOLD
    inked_count = int(inked.sum())

    if inked_count < _MIN_INKED_BLOCKS:
        notes.append(
            "Too little printed content to establish a compression baseline "
            f"({inked_count} inked blocks); no tamper score was computed."
        )
        return ForensicsReport(
            ela_applied=False,
            tamper_score=0.0,
            regions=[],
            encoding=encoding,
            baseline_energy=0.0,
            baseline_deviation=0.0,
            notes=notes,
        )

    values = ela_blocks[inked]
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    deviation = mad * _MAD_TO_SIGMA

    if deviation <= 1e-6:
        # A page whose inked blocks all compress identically. Real, and it means
        # there is no spread to measure an outlier against.
        notes.append(
            "Compression response is uniform across the page; no local "
            "anomaly is distinguishable."
        )
        return ForensicsReport(
            ela_applied=False,
            tamper_score=0.0,
            regions=[],
            encoding=encoding,
            baseline_energy=round(median, 4),
            baseline_deviation=0.0,
            notes=notes,
        )

    z_scores = np.where(inked, (ela_blocks - median) / deviation, -np.inf)

    regions: list[ElaRegion] = []
    for row, col in zip(*np.where(z_scores >= _REGION_Z)):
        regions.append(
            ElaRegion(
                box=(
                    int(col * block),
                    int(row * block),
                    int((col + 1) * block),
                    int((row + 1) * block),
                ),
                z_score=round(float(z_scores[row, col]), 3),
                energy=round(float(ela_blocks[row, col]), 3),
            )
        )
    regions.sort(key=lambda r: r.z_score, reverse=True)

    peak = float(z_scores.max()) if np.isfinite(z_scores).any() else 0.0
    score = 0.0 if peak <= _REGION_Z else min(
        1.0, (peak - _REGION_Z) / (_SATURATION_Z - _REGION_Z)
    )

    if encoding.software_tags:
        notes.append(
            "Metadata names image-processing software: "
            + ", ".join(encoding.software_tags)
        )
    if not encoding.has_exif:
        notes.append(
            "No EXIF metadata. Normal for a scanned or exported document and "
            "not itself a signal."
        )

    return ForensicsReport(
        # Cap the reported list: a reviewer needs the strongest regions, and a
        # heavily textured page can produce hundreds.
        tamper_score=round(score, 4),
        regions=regions[:12],
        encoding=encoding,
        baseline_energy=round(median, 4),
        baseline_deviation=round(deviation, 4),
        notes=notes,
    )


def analyze_pdf(content: PdfContent, settings: Settings) -> ForensicsReport:
    """
    Forensics for a PDF upload. See pdf.py for why ELA runs on the embedded scan
    and on nothing else. Region boxes are in the scan's own pixel coordinates.
    """
    if content.scan_jpeg is not None:
        scan = Image.open(io.BytesIO(content.scan_jpeg))
        scan.load()
        report = analyze(scan, content.scan_jpeg, settings)
        report.notes.insert(0, "Analysed the scanned JPEG embedded in the PDF.")
    else:
        report = ForensicsReport(
            ela_applied=False,
            tamper_score=0.0,
            regions=[],
            encoding=EncodingReport(format="PDF", width=content.page.width, height=content.page.height),
            baseline_energy=0.0,
            baseline_deviation=0.0,
            notes=[
                "The PDF page is not a single embedded JPEG scan (it is vector text, or "
                "several images), so error level analysis does not apply and no tamper "
                "score was computed."
            ],
        )

    written_by = [tag for tag in (content.producer, content.creator) if tag]
    if written_by:
        report.encoding.software_tags.extend(written_by)
        report.notes.append("PDF written by: " + ", ".join(written_by))
    report.notes.extend(content.notes)
    return report
