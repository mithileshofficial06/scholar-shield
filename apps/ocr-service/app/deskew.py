"""
Skew correction.

WHY THIS RUNS BEFORE TESSERACT
------------------------------
The degradation pipeline rotates every document by up to 3 degrees, and a real
phone photo does worse. Tesseract tolerates perhaps a degree before word boxes
start straddling lines, and label-anchored extraction depends entirely on
"same line, to the right of the label" being a meaningful statement. At 3
degrees across a 900px page the right-hand edge of a line sits ~47px below its
left-hand edge — more than a line height. So deskew is not a quality tweak
here; without it the extraction strategy does not work at all.

METHOD
------
Projection-profile variance. Text lines produce alternating dark and light rows
in a horizontal projection; that alternation is sharpest when lines are exactly
horizontal, so the angle maximising the variance of the row-sum profile is the
skew. It is slower than a Hough transform and more robust on sparse forms,
where Hough locks onto the page frame instead of the text.

The search runs on a downscaled copy: skew is a global property, and estimating
it at full resolution costs time without changing the answer.
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image

# Skew search happens at this width. Wide enough that a line of body text spans
# many pixels, small enough that ~50 rotations stay cheap.
_SEARCH_WIDTH = 700


def _otsu_threshold(gray: np.ndarray) -> float:
    """Otsu's method — the page is bimodal (ink, paper) even under a gradient."""
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size
    sum_all = float(np.dot(np.arange(256), hist))

    sum_bg = 0.0
    weight_bg = 0
    best_variance = -1.0
    best_threshold = 127.0

    for level in range(256):
        weight_bg += int(hist[level])
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break

        sum_bg += level * float(hist[level])
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_all - sum_bg) / weight_fg

        between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if between > best_variance:
            best_variance = between
            best_threshold = float(level)

    return best_threshold


def _profile_score(binary: np.ndarray, angle: float) -> float:
    """Variance of the horizontal ink profile after rotating by `angle`."""
    if angle == 0.0:
        rotated = binary
    else:
        rotated = np.asarray(
            Image.fromarray(binary).rotate(
                angle, resample=Image.Resampling.BILINEAR, fillcolor=0
            )
        )

    profile = rotated.sum(axis=1, dtype=np.float64)
    # Variance alone rewards any rotation that crops ink into the fill area, so
    # normalise by total ink: the score becomes "how concentrated", not "how much".
    total = profile.sum()
    if total <= 0:
        return 0.0
    return float(np.var(profile / total))


def estimate_skew(image: Image.Image, max_degrees: float, step: float) -> float:
    """
    Degrees the page must be rotated counter-clockwise to level it.

    Returns 0.0 when the page carries too little ink to judge — a blank or
    near-blank scan should pass through untouched rather than be rotated on
    the strength of noise.
    """
    gray = image.convert("L")
    scale = _SEARCH_WIDTH / gray.width
    if scale < 1.0:
        gray = gray.resize(
            (_SEARCH_WIDTH, max(1, round(gray.height * scale))),
            Image.Resampling.BILINEAR,
        )

    array = np.asarray(gray, dtype=np.uint8)
    threshold = _otsu_threshold(array)
    # Ink is dark, so ink == below threshold. Stored as 0/255 so PIL can rotate it.
    binary = ((array < threshold) * 255).astype(np.uint8)

    ink_ratio = float((binary > 0).mean())
    if ink_ratio < 0.005 or ink_ratio > 0.9:
        return 0.0

    best_angle = 0.0
    best_score = -1.0

    steps = int(round((2 * max_degrees) / step)) + 1
    for i in range(steps):
        angle = -max_degrees + i * step
        score = _profile_score(binary, angle)
        if score > best_score:
            best_score = score
            best_angle = angle

    return round(best_angle, 3)


def deskew(image: Image.Image, max_degrees: float, step: float) -> tuple[Image.Image, float]:
    """Level the page. Returns the corrected image and the angle applied."""
    angle = estimate_skew(image, max_degrees, step)
    if angle == 0.0:
        return image, 0.0

    # Expand so no text is cropped, and fill with paper rather than black —
    # a black margin drags Otsu's threshold down inside Tesseract too.
    corrected = image.rotate(
        angle,
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=(246, 244, 238) if image.mode == "RGB" else 246,
    )
    return corrected, angle


def to_original_coordinates(
    box: tuple[int, int, int, int],
    angle: float,
    deskewed_size: tuple[int, int],
    original_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    """
    Map a box found on the deskewed page back onto the page as uploaded.

    WHY THIS IS NEEDED
    ------------------
    Deskew rotates with `expand=True`, so the levelled page is larger than the
    original — a box near the right margin can legitimately have an x beyond the
    original width. A reviewer's overlay is drawn on the stored document, not on
    an intermediate this service threw away, so coordinates that only make sense
    against that intermediate are worse than useless: they land in the wrong
    place and look authoritative doing it.

    Rotating a box yields a quadrilateral, not a box. The axis-aligned bounding
    box of the four mapped corners is returned instead — slightly larger than
    the true region, which is the right direction to err for a highlight.
    """
    if angle == 0.0:
        return box

    theta = math.radians(angle)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    # PIL maps each output pixel back to its input, so the inverse of the
    # rotation it applied is exactly this forward transform about the centres.
    cx1, cy1 = deskewed_size[0] / 2.0, deskewed_size[1] / 2.0
    cx0, cy0 = original_size[0] / 2.0, original_size[1] / 2.0

    left, top, right, bottom = box
    xs: list[float] = []
    ys: list[float] = []
    for x, y in ((left, top), (right, top), (left, bottom), (right, bottom)):
        dx, dy = x - cx1, y - cy1
        xs.append(cos_t * dx + sin_t * dy + cx0)
        ys.append(-sin_t * dx + cos_t * dy + cy0)

    width, height = original_size
    return (
        max(0, min(width, round(min(xs)))),
        max(0, min(height, round(min(ys)))),
        max(0, min(width, round(max(xs)))),
        max(0, min(height, round(max(ys)))),
    )
