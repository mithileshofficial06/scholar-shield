"""
Document forensics.

READ THIS BEFORE CHANGING THE CORPUS ASSERTION
----------------------------------------------
`test_ela_does_not_separate_tampered_from_control` asserts that ELA is NOT
discriminative on this corpus. That is not a bug being tolerated — it is the
measured result, and it is the whole reason the control group exists
(PROJECT_REPORT.md §7.3). Without a group carrying identical compression
history and no edit, "ELA flagged 90% of forgeries" could equally mean "ELA
flags 90% of everything", and nobody could tell which.

The measurement came out at chance. If a future detector genuinely separates the
two groups this test will fail, and the correct response is to update the
published number in the README — not to delete the test. Locking the measurement
in place is what stops the figure in the README from drifting away from what the
code actually does.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from app import forensics


def jpeg_page(quality: int = 80) -> tuple[Image.Image, bytes]:
    image = Image.new("RGB", (600, 800), (250, 249, 245))
    draw = ImageDraw.Draw(image)
    for i in range(14):
        y = 60 + i * 50
        draw.rectangle([60, y, 540, y + 14], fill=(28, 28, 28))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    raw = buffer.getvalue()
    return Image.open(io.BytesIO(raw)), raw


def auc(positive: list[float], negative: list[float]) -> float:
    """
    Probability that a randomly chosen positive outranks a randomly chosen
    negative. 0.5 is chance. Computed directly rather than pulled from sklearn —
    it is six lines and avoids a dependency the service does not otherwise need.
    """
    if not positive or not negative:
        return 0.5
    wins = 0.0
    for p in positive:
        for n in negative:
            wins += 1.0 if p > n else 0.5 if p == n else 0.0
    return wins / (len(positive) * len(negative))


class TestNonLossyInput:
    def test_png_gets_a_note_and_no_score(self, settings):
        """
        ELA on a lossless image compares it against its FIRST lossy encode, so
        the entire page reads as anomalous. Returning 0.0 with an explanation
        beats returning a large number that looks like evidence.
        """
        image = Image.new("RGB", (400, 400), (250, 250, 250))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        raw = buffer.getvalue()

        report = forensics.analyze(Image.open(io.BytesIO(raw)), raw, settings)

        assert report.tamper_score == 0.0
        assert report.regions == []
        assert any("does not apply" in note for note in report.notes)


class TestInsufficientContent:
    def test_blank_jpeg_reports_no_baseline(self, settings):
        """A page with no print has no compression history to be inconsistent
        with, so there is nothing to measure against."""
        image = Image.new("RGB", (600, 800), (250, 249, 245))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=80)
        raw = buffer.getvalue()

        report = forensics.analyze(Image.open(io.BytesIO(raw)), raw, settings)

        assert report.tamper_score == 0.0
        assert any("baseline" in note or "uniform" in note for note in report.notes)


class TestScoreShape:
    def test_score_stays_within_bounds(self, settings):
        image, raw = jpeg_page()
        report = forensics.analyze(image, raw, settings)
        assert 0.0 <= report.tamper_score <= 1.0

    def test_regions_are_ranked_strongest_first(self, settings):
        image, raw = jpeg_page(quality=60)
        report = forensics.analyze(image, raw, settings)
        scores = [region.z_score for region in report.regions]
        assert scores == sorted(scores, reverse=True)

    def test_region_list_is_capped(self, settings):
        image, raw = jpeg_page(quality=45)
        report = forensics.analyze(image, raw, settings)
        assert len(report.regions) <= 12

    def test_baseline_is_published_with_the_score(self, settings):
        """The denominator is part of the claim. A z-score without the spread it
        was measured against is not checkable."""
        image, raw = jpeg_page()
        report = forensics.analyze(image, raw, settings)
        assert report.baseline_energy >= 0.0
        assert report.baseline_deviation >= 0.0


class TestEncodingMetadata:
    def test_reports_format_and_dimensions(self, settings):
        image, raw = jpeg_page()
        report = forensics.analyze(image, raw, settings)
        assert report.encoding.format == "JPEG"
        assert (report.encoding.width, report.encoding.height) == (600, 800)

    def test_quantization_signature_tracks_save_quality(self, settings):
        """Two documents saved at different qualities carry different tables.
        This is what makes 'these two files came from different pipelines'
        a statement a reviewer can check."""
        low = forensics.read_encoding(*jpeg_page(quality=50))
        high = forensics.read_encoding(*jpeg_page(quality=95))
        assert low.quant_signature != high.quant_signature
        assert low.estimated_quality is not None
        assert high.estimated_quality is not None
        assert high.estimated_quality > low.estimated_quality

    def test_absent_exif_is_noted_as_unremarkable(self, settings):
        image, raw = jpeg_page()
        report = forensics.analyze(image, raw, settings)
        assert any("not itself a signal" in note for note in report.notes)


@pytest.mark.slow
class TestAgainstTheCorpus:
    """Requires `npm run seed:documents`. Deselected by default — see pytest.ini."""

    @staticmethod
    def _scores(manifest, settings, variant: str) -> list[float]:
        from conftest import CORPUS_ROOT, documents

        scores = []
        for entry in documents(manifest, variant):
            path = CORPUS_ROOT / entry["file"]
            raw = path.read_bytes()
            report = forensics.analyze(Image.open(path), raw, settings)
            scores.append(report.tamper_score)
        return scores

    def test_ela_does_not_separate_tampered_from_control(self, manifest, settings):
        """
        THE MEASUREMENT, LOCKED IN. See this module's docstring before editing.

        Tampered and control documents differ in exactly one respect: whether a
        region was repainted. Everything else — compression chain, degradation
        seed, rotation, illumination, noise — is identical by construction. So
        an AUC near 0.5 says ELA carries no usable signal here, and the reason
        is in db/seed/tamper.ts: the forger re-encodes through a different
        library, and degradation then re-compresses the whole page on top of the
        edit at a LOWER quality than the edit itself, erasing the local history.
        """
        tampered = self._scores(manifest, settings, "tampered")
        control = self._scores(manifest, settings, "control")

        measured = auc(tampered, control)
        assert 0.35 <= measured <= 0.65, (
            f"ELA separation moved to AUC {measured:.3f}. If a detector change "
            "caused this, update the published figure in README.md and "
            "PROJECT_REPORT.md rather than widening this bound."
        )

    def test_control_group_false_positive_rate_is_measurable(self, manifest, settings):
        """
        Controls are untampered by construction, so any score above the
        reporting threshold is a false positive. This publishes the denominator
        rather than asserting the rate is low.
        """
        control = self._scores(manifest, settings, "control")
        assert control, "no control documents in the manifest"

        flagged = sum(1 for score in control if score >= 0.5)
        rate = flagged / len(control)
        # Recorded, not aspirational: this is what the detector does today.
        assert 0.0 <= rate <= 0.25
