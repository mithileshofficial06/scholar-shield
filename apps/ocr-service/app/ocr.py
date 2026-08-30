"""
Field extraction from a rendered income certificate.

STRATEGY — LABEL-ANCHORED, NOT COORDINATE-ANCHORED
--------------------------------------------------
The synthetic renderer puts every value at a known offset, so extraction by
fixed coordinates would score near-perfectly on this corpus and collapse on any
real certificate, or on the same certificate photographed at a different
distance. That would make the published OCR accuracy a measurement of the
renderer, not of the reader.

So nothing here knows a coordinate. Each field is found by locating its printed
label and taking the words to the right of it on the same line. What survives is
the form's *structure* — a label column and a value column — which is a property
every income certificate in this format shares, not a property of this
generator. It costs accuracy on the corpus and buys a number that means
something.

The one field that breaks the pattern is the issuing authority, printed *below*
its label rather than beside it. It is handled as a stated exception rather than
by loosening the rule for everything.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

import pytesseract
from PIL import Image

from .config import Settings
from .deskew import deskew, to_original_coordinates
from .models import ExtractedField, ExtractionReport
from .preprocess import OCR_SCALE, prepare_for_ocr

# Tesseract emits -1 for layout blocks that contain no text at all; those are
# the only words dropped here.
#
# An earlier version discarded everything below confidence 30, which looked
# prudent and quietly corrupted values: "Rs. 1,78,000/-" came back as
# "Rs. 1,78," because the final token scored 27, and a certificate number lost
# its last group entirely. A truncated number is far more dangerous than a
# low-confidence one — it parses cleanly into the wrong amount, where a
# low-confidence read at least arrives labelled as uncertain. Filtering is the
# consumer's decision to make, and it can only make it if nothing was thrown
# away first.
_MIN_WORD_CONFIDENCE = 0.0


@dataclass(frozen=True)
class Word:
    text: str
    left: int
    top: int
    width: int
    height: int
    confidence: float
    line_key: tuple[int, int, int, int]

    @property
    def right(self) -> int:
        return self.left + self.width


@dataclass(frozen=True)
class Line:
    words: tuple[Word, ...]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


def _normalize(value: str) -> str:
    """Lowercase, alphanumerics only — OCR punctuation is not worth matching on."""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def read_words(image: Image.Image, settings: Settings) -> list[Word]:
    """Every word Tesseract found, with its box and confidence."""
    data = pytesseract.image_to_data(
        image,
        lang=settings.tesseract_lang,
        config="--psm {}".format(settings.tesseract_psm),
        output_type=pytesseract.Output.DICT,
    )

    words: list[Word] = []
    for i in range(len(data["text"])):
        text = (data["text"][i] or "").strip()
        if not text:
            continue
        try:
            confidence = float(data["conf"][i])
        except (TypeError, ValueError):
            continue
        if confidence <= _MIN_WORD_CONFIDENCE:
            continue

        words.append(
            Word(
                text=text,
                left=int(data["left"][i]),
                top=int(data["top"][i]),
                width=int(data["width"][i]),
                height=int(data["height"][i]),
                confidence=confidence,
                line_key=(
                    int(data["page_num"][i]),
                    int(data["block_num"][i]),
                    int(data["par_num"][i]),
                    int(data["line_num"][i]),
                ),
            )
        )
    return words


def group_lines(words: list[Word]) -> list[Line]:
    """
    Tesseract's own line grouping, re-sorted left-to-right.

    Its line numbering is reliable on a deskewed page and already accounts for
    variable line height, which a y-coordinate clustering pass would have to
    rediscover badly.
    """
    buckets: dict[tuple[int, int, int, int], list[Word]] = {}
    for word in words:
        buckets.setdefault(word.line_key, []).append(word)

    lines = [
        Line(words=tuple(sorted(group, key=lambda w: w.left)))
        for group in buckets.values()
    ]
    lines.sort(key=lambda line: line.words[0].top)
    return lines


"""Ranking of a label match: exact token count beats a merged or dropped one."""
_EXACT, _MERGED, _DROPPED = 2, 1, 0


def _find_label(
    line: Line,
    label: str,
    midline: bool = False,
    threshold: float = 0.78,
) -> tuple[int, float, Word] | None:
    """
    Best match for `label` in `line` as (rank, score, label-end word), or None.
    The label-end word is where the value column begins.

    THREE RULES, EACH EARNED FROM A MISREAD ON THE CORPUS
    -----------------------------------------------------
    1. A window of k tokens is compared against the label's first k tokens, not
       against the whole label. Tesseract drops the last word of "Members in
       Family" often enough to matter: comparing "Members in" to the full label
       scores 0.75 and misses, comparing it to the two-token prefix scores 1.0.
       Truncating the target tolerates a dropped token without lowering the
       threshold for every other field.

    2. The dropped-token fallback applies only to labels of three tokens or
       more. One token out of two leaves too little to identify anything: "PIN"
       is a 0.80 match for the "in" of "(in words)", which is how the
       income-in-words field first extracted the PIN code.

    3. Labels must start their line unless the field is declared `midline`. The
       masthead reads "TAMIL NADU e-DISTRICT — SIMULATED", and "e-DISTRICT" is a
       0.94 match for the "District" label — so without an anchor the District
       field extracts "— SIMULATED" from the header. Form labels occupy the left
       column by construction; the only one legitimately mid-line is the issue
       date, which shares its line with the certificate number.

    The rank is returned rather than resolved here because the caller compares
    across every line, not just within one: a weak match on an early line must
    not beat an exact match further down the page.
    """
    label_tokens = label.split()
    span = len(label_tokens)

    sizes = [(span, _EXACT), (span + 1, _MERGED)]
    if span >= 3:
        sizes.append((span - 1, _DROPPED))

    best: tuple[int, float, Word] | None = None
    for size, rank in sizes:
        target = _normalize(" ".join(label_tokens[: min(size, span)]))
        if not target:
            continue
        for start in range(0, max(0, len(line.words) - size + 1)):
            if start > 0 and not midline:
                break
            window = line.words[start : start + size]
            candidate = _normalize(" ".join(w.text for w in window))
            if not candidate:
                continue
            score = _similar(candidate, target)
            if score < threshold:
                continue
            if best is None or (rank, score) > (best[0], best[1]):
                best = (rank, score, window[-1])
    return best


def _value_after(
    line: Line,
    label_end: Word,
    stop_before: str | None = None,
) -> tuple[str, float, tuple[int, int, int, int]] | None:
    """
    Words to the right of the label, joined.

    `stop_before` handles the one line carrying two fields — certificate number
    on the left, issue date on the right — by cutting the value where the second
    label starts, instead of swallowing it.
    """
    tail = [w for w in line.words if w.left >= label_end.right - 2]
    if not tail:
        return None

    if stop_before:
        stop_norm = _normalize(stop_before)
        cut = len(tail)
        for index, word in enumerate(tail):
            if _similar(_normalize(word.text), stop_norm) >= 0.8:
                cut = index
                break
        tail = tail[:cut]

    if not tail:
        return None

    value = " ".join(w.text for w in tail).strip(" :.-")
    if not value:
        return None

    confidence = sum(w.confidence for w in tail) / len(tail) / 100.0
    box = (
        min(w.left for w in tail),
        min(w.top for w in tail),
        max(w.right for w in tail),
        max(w.top + w.height for w in tail),
    )
    return value, max(0.0, min(1.0, confidence)), box


@dataclass(frozen=True)
class FieldSpec:
    label: str
    name: str
    # Second label on the same line, where this field's value must stop.
    stop_before: str | None = None
    # May the label appear away from the start of its line? See _find_label.
    midline: bool = False


_ROW_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("Name of Applicant", "applicant_name"),
    FieldSpec("Father / Guardian", "guardian_name"),
    FieldSpec("Address", "address"),
    FieldSpec("District", "district"),
    FieldSpec("PIN Code", "pincode"),
    FieldSpec("Members in Family", "family_size"),
    FieldSpec("Annual Family Income", "annual_income"),
    FieldSpec("in words", "annual_income_words"),
    FieldSpec("Certificate No.", "certificate_id", stop_before="Date"),
    FieldSpec("Date of Issue", "issue_date", midline=True),
)

FIELD_NAMES: tuple[str, ...] = tuple(spec.name for spec in _ROW_FIELDS) + (
    "issuing_office",
)


def _empty() -> ExtractedField:
    return ExtractedField(value=None, confidence=0.0, box=None)


def extract_fields(lines: list[Line]) -> dict[str, ExtractedField]:
    fields: dict[str, ExtractedField] = {name: _empty() for name in FIELD_NAMES}

    for spec in _ROW_FIELDS:
        # Every line is a candidate, and the strongest match wins — not the
        # first one down the page. Scanning top-down and taking the first hit
        # let the "PIN Code" line claim the income-in-words label before the
        # real "(in words)" line was ever reached.
        best: tuple[tuple[int, float], str, float, tuple[int, int, int, int]] | None = None

        for line in lines:
            match = _find_label(line, spec.label, spec.midline)
            if match is None:
                continue
            rank, score, label_end = match
            found = _value_after(line, label_end, spec.stop_before)
            if found is None:
                continue
            value, confidence, box = found
            if best is None or (rank, score) > best[0]:
                best = ((rank, score), value, confidence, box)

        if best is not None:
            _, value, confidence, box = best
            fields[spec.name] = ExtractedField(
                value=value, confidence=confidence, box=box
            )

    # Stated exception: the issuing authority is printed on the line BELOW its
    # label, not beside it (see certificate.ts). Nothing else on the form does
    # this, so it is special-cased rather than made general.
    for index, line in enumerate(lines):
        if _find_label(line, "Issuing Authority") is None:
            continue
        if index + 1 >= len(lines):
            break
        below = lines[index + 1]
        value = below.text.strip(" :.-")
        if not value:
            break
        confidence = sum(w.confidence for w in below.words) / len(below.words) / 100.0
        fields["issuing_office"] = ExtractedField(
            value=value,
            confidence=max(0.0, min(1.0, confidence)),
            box=(
                min(w.left for w in below.words),
                min(w.top for w in below.words),
                max(w.right for w in below.words),
                max(w.top + w.height for w in below.words),
            ),
        )
        break

    return fields


def parse_income(value: str | None) -> int | None:
    """`Rs. 1,78,000/-` becomes 178000. Returns None rather than guessing."""
    if not value:
        return None
    digits = re.sub(r"[^0-9]", "", value.split("/")[0])
    if not digits:
        return None
    try:
        parsed = int(digits)
    except ValueError:
        return None
    # A household income outside this band is a misread, not a declaration.
    return parsed if 1_000 <= parsed <= 100_000_000 else None


_WORD_VALUES = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_WORD_SCALES = {"hundred": 100, "thousand": 1_000, "lakh": 100_000, "crore": 10_000_000}


def parse_income_words(value: str | None) -> int | None:
    """
    `One Lakh Seventy Eight Thousand Rupees Only` becomes 178000.

    Indian scale words, so `lakh` and `crore` close the group before them rather
    than multiplying the running total: `Two Lakh Fifty Thousand` is 250000.
    """
    if not value:
        return None

    total = 0
    group = 0
    seen = False

    for raw in re.findall(r"[a-z]+", value.lower()):
        if raw in _WORD_VALUES:
            group += _WORD_VALUES[raw]
            seen = True
        elif raw in _WORD_SCALES:
            scale = _WORD_SCALES[raw]
            if group == 0:
                group = 1
            if scale >= 1_000:
                total += group * scale
                group = 0
            else:
                group *= scale
            seen = True

    if not seen:
        return None
    result = total + group
    return result if result > 0 else None


def parse_family_size(value: str | None) -> int | None:
    if not value:
        return None
    digits = re.sub(r"[^0-9]", "", value)
    if not digits:
        return None
    size = int(digits)
    return size if 1 <= size <= 30 else None


def _to_page_coordinates(
    field: ExtractedField,
    angle: float,
    deskewed_size: tuple[int, int],
    original_size: tuple[int, int],
) -> ExtractedField:
    """
    Convert a box from OCR space to the uploaded page.

    Two transforms, in order: divide out the OCR upscale, then undo the deskew
    rotation. Callers draw overlays on the document they stored, and should not
    have to know either intermediate existed.
    """
    if field.box is None:
        return field

    unscaled = tuple(round(v / OCR_SCALE) for v in field.box)
    return field.model_copy(
        update={
            "box": to_original_coordinates(
                unscaled, angle, deskewed_size, original_size
            )
        }
    )


def analyze(image: Image.Image, settings: Settings) -> ExtractionReport:
    original_size = (image.width, image.height)
    leveled, angle = deskew(image, settings.max_skew_degrees, settings.skew_step_degrees)
    deskewed_size = (leveled.width, leveled.height)

    words = read_words(prepare_for_ocr(leveled), settings)
    lines = group_lines(words)
    fields = {
        name: _to_page_coordinates(field, angle, deskewed_size, original_size)
        for name, field in extract_fields(lines).items()
    }

    page_confidence = (
        sum(w.confidence for w in words) / len(words) / 100.0 if words else 0.0
    )

    figure = parse_income(fields["annual_income"].value)
    written = parse_income_words(fields["annual_income_words"].value)
    mismatch = None if figure is None or written is None else figure != written

    return ExtractionReport(
        fields=fields,
        skew_corrected_degrees=angle,
        page_confidence=round(page_confidence, 4),
        word_count=len(words),
        income_words_mismatch=mismatch,
    )
