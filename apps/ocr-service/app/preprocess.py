"""
Image preparation for OCR.

WHY THIS EXISTS
---------------
Tesseract on the raw corpus reads at 0.62 mean word confidence and finds 71
words on a page that has around 110. The degradation pipeline (db/seed/degrade.ts)
is the reason: it composites a diagonal illumination gradient, adds sensor
noise, and saves at quality 65-85. That is deliberate — it is what a phone photo
of a certificate looks like — so the fix belongs here, not in a gentler corpus.

Flat-fielding plus a 2x upscale takes the same pages to 0.94 confidence and ~107
words. Both steps address a specific measured problem:

  * FLAT-FIELD. The illumination gradient moves the ink/paper boundary across
    the page, so no single global threshold works — and Tesseract binarises
    globally. Dividing by a heavily blurred copy of the page estimates the
    local paper brightness and divides it out, which is what a scanner's own
    calibration does. Radius 25 is wide enough to model the gradient and the
    watermark without absorbing the glyphs themselves.

  * UPSCALE. Body text on this form is ~12px tall. Tesseract's models want
    roughly 30px of x-height, and it does not upsample internally. Lanczos to
    2x costs a few hundred milliseconds and is worth more than every other
    tweak tried.

Deliberately NOT done: autocontrast and unsharp masking. Both raise the word
count (125-161) while lowering mean confidence, because what they recover is the
SYNTHETIC watermark and seal being read as text. More words that are not on the
form is not better OCR.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

# Radius of the background estimate, in pixels of the original page.
_BACKGROUND_RADIUS = 25

# Target paper level after division. Slightly below pure white leaves headroom
# so faint ink does not clip away.
_PAPER_LEVEL = 220.0

# OCR runs at this multiple of the input size. Box coordinates are divided back
# down before they leave the service, so callers always see page coordinates.
OCR_SCALE = 2


def flat_field(image: Image.Image, radius: int = _BACKGROUND_RADIUS) -> Image.Image:
    """Divide out the local paper brightness, flattening uneven illumination."""
    gray = image.convert("L")
    background = gray.filter(ImageFilter.BoxBlur(radius))

    foreground = np.asarray(gray, dtype=np.float32)
    estimate = np.asarray(background, dtype=np.float32)

    # Clamp the divisor: a genuinely black region would otherwise divide by ~0
    # and explode into white.
    corrected = np.clip(foreground / np.maximum(estimate, 1.0) * _PAPER_LEVEL, 0, 255)
    return Image.fromarray(corrected.astype(np.uint8))


def prepare_for_ocr(image: Image.Image) -> Image.Image:
    """Flat-field, then upscale. The order matters: blurring an upscaled page
    costs 4x the work for the same background estimate."""
    flattened = flat_field(image)
    return flattened.resize(
        (flattened.width * OCR_SCALE, flattened.height * OCR_SCALE),
        Image.Resampling.LANCZOS,
    )
