"""
Grading extracted fields against the corpus manifest's ground truth.

Lives in the package rather than in the tests because two different callers need
the identical definition of "correct": the pytest accuracy floor, and
`apps/api/scripts/metrics.ts`, which publishes the number into the README. Two
implementations would eventually disagree, and the published figure would stop
describing what the test enforces.

WHAT COUNTS AS CORRECT
----------------------
Numeric fields — income, family size — are compared as parsed integers. A
certificate reading `Rs. 76,000/-` and one reading `Rs 76000` carry the same
declaration, and an OCR score that penalises the punctuation is measuring
formatting, not reading.

Text fields are compared after case-folding and whitespace collapsing, but NOT
after fuzzy matching. `Bhavani Shankar` read as `Bhavarni Shankar` is wrong: it
is a different person as far as entity resolution is concerned, and grading it
as a near-miss would inflate the published accuracy exactly where the household
engine is most sensitive to error.
"""

from __future__ import annotations

import re
import unicodedata

from .models import ExtractedField
from .ocr import parse_family_size, parse_income

# manifest truth key -> extracted field name
TEXT_FIELDS: dict[str, str] = {
    "applicantName": "applicant_name",
    "guardianName": "guardian_name",
    "address": "address",
    "district": "district",
    "pincode": "pincode",
    "certificateId": "certificate_id",
    "issueDate": "issue_date",
    "issuingOffice": "issuing_office",
}

NUMERIC_FIELDS: dict[str, str] = {
    "annualIncome": "annual_income",
    "familySize": "family_size",
}

GRADED_FIELDS: tuple[str, ...] = tuple(TEXT_FIELDS) + tuple(NUMERIC_FIELDS)


def canonical(value: str | None) -> str:
    """Case-folded, whitespace-collapsed, punctuation-normalised."""
    if value is None:
        return ""
    # The renderer uses an en dash in some office names; OCR returns a hyphen.
    # That is a glyph difference, not a reading error.
    text = unicodedata.normalize("NFKD", value)
    text = text.replace("–", "-").replace("—", "-")
    text = re.sub(r"[^\w\s-]", " ", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def grade_field(
    truth_key: str,
    truth_value: object,
    field: ExtractedField | None,
) -> bool:
    """Did the reader recover this field correctly?"""
    if field is None:
        return False

    if truth_key in NUMERIC_FIELDS:
        parser = parse_income if truth_key == "annualIncome" else parse_family_size
        return parser(field.value) == truth_value

    return canonical(field.value) == canonical(str(truth_value))


def grade_document(
    truth: dict[str, object],
    fields: dict[str, ExtractedField],
) -> dict[str, bool]:
    """Per-field correctness for one document."""
    results: dict[str, bool] = {}
    for truth_key in GRADED_FIELDS:
        name = {**TEXT_FIELDS, **NUMERIC_FIELDS}[truth_key]
        results[truth_key] = grade_field(truth_key, truth.get(truth_key), fields.get(name))
    return results
