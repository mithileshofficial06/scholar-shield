"""
Skew estimation.

Deskew is load-bearing, not cosmetic: label-anchored extraction depends on
"same line, to the right of the label" being meaningful, and at 3 degrees across
a 900px page the right edge of a line sits below the left edge by more than a
line height. If this regresses, extraction does not degrade — it stops working.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.deskew import deskew, estimate_skew

MAX_DEGREES = 6.0
STEP = 0.25


def page(lines: int = 18) -> Image.Image:
    """A page of ruled text bars — the projection profile of real body text."""
    image = Image.new("RGB", (900, 1180), (250, 249, 245))
    draw = ImageDraw.Draw(image)
    for i in range(lines):
        y = 120 + i * 55
        draw.rectangle([120, y, 780, y + 16], fill=(30, 30, 30))
    return image


def rotated(image: Image.Image, degrees: float) -> Image.Image:
    return image.rotate(
        degrees, resample=Image.Resampling.BICUBIC, expand=True,
        fillcolor=(246, 244, 238),
    )


class TestEstimateSkew:
    def test_level_page_needs_no_correction(self):
        assert abs(estimate_skew(page(), MAX_DEGREES, STEP)) <= STEP

    @pytest.mark.parametrize("angle", [-3.0, -1.5, -0.5, 0.5, 1.5, 3.0])
    def test_recovers_a_known_rotation(self, angle):
        """
        The corpus rotates by up to 3 degrees. Tolerance is two search steps:
        the estimate is quantised to `STEP`, so demanding better than that would
        be asserting against the grid rather than the measurement.
        """
        estimate = estimate_skew(rotated(page(), angle), MAX_DEGREES, STEP)
        assert estimate == pytest.approx(-angle, abs=2 * STEP)

    def test_blank_page_is_left_alone(self):
        """Rotating a page on the strength of noise is worse than not trying."""
        blank = Image.new("RGB", (900, 1180), (250, 249, 245))
        assert estimate_skew(blank, MAX_DEGREES, STEP) == 0.0

    def test_saturated_page_is_left_alone(self):
        solid = Image.new("RGB", (900, 1180), (10, 10, 10))
        assert estimate_skew(solid, MAX_DEGREES, STEP) == 0.0


class TestDeskew:
    def test_returns_the_angle_it_applied(self):
        corrected, angle = deskew(rotated(page(), 2.0), MAX_DEGREES, STEP)
        assert angle == pytest.approx(-2.0, abs=2 * STEP)
        assert corrected is not None

    def test_untouched_page_is_returned_unchanged(self):
        original = page()
        corrected, angle = deskew(original, MAX_DEGREES, STEP)
        if angle == 0.0:
            assert corrected is original

    def test_correction_does_not_crop_content(self):
        """`expand=True` matters: rotating in place clips the corners of a page
        that is already close to the edge of its own canvas."""
        source = rotated(page(), 3.0)
        corrected, angle = deskew(source, MAX_DEGREES, STEP)
        assert angle != 0.0
        assert corrected.width >= source.width - 1
        assert corrected.height >= source.height - 1

    def test_fill_is_paper_coloured_not_black(self):
        """A black margin drags Tesseract's own global threshold down and
        costs confidence across the whole page."""
        corrected, _ = deskew(rotated(page(), 3.0), MAX_DEGREES, STEP)
        corner = np.asarray(corrected.convert("L"))[2, 2]
        assert corner > 200

    def test_deskewing_sharpens_the_projection_profile(self):
        """The property the method rests on, asserted directly rather than
        through an angle: a levelled page has a more concentrated row profile
        than a skewed one."""
        def concentration(image: Image.Image) -> float:
            gray = np.asarray(image.convert("L"), dtype=np.float64)
            ink = 255.0 - gray
            profile = ink.sum(axis=1)
            return float(np.var(profile / profile.sum()))

        skewed = rotated(page(), 3.0)
        corrected, _ = deskew(skewed, MAX_DEGREES, STEP)
        assert concentration(corrected) > concentration(skewed)
