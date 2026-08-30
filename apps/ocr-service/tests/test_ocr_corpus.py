"""
OCR accuracy against the degraded corpus.

Slow and deselected by default (see pytest.ini). The published figure comes from
`npm run metrics`, which runs every document; this asserts a floor so a
regression fails a test instead of quietly lowering a number in the README.

WHY THE FLOOR IS BELOW THE MEASURED VALUE
-----------------------------------------
Measured field accuracy is 92.5% across all 67 documents. The floor is set at
88% because Tesseract's output is not guaranteed identical across versions and
platforms, and a test that fails when someone upgrades a system package is a
test people delete. The gap is the tolerance, not slack to spend: the README
publishes what was measured, not the floor.
"""

from __future__ import annotations

import pytest
from PIL import Image

from app import grading, ocr
from conftest import CORPUS_ROOT

# Below the measured 92.5%; see the module docstring.
FIELD_ACCURACY_FLOOR = 0.88

# Per-field floors for the fields the household engine depends on. Names and
# income drive entity resolution and the contradiction rules, so a regression
# there matters more than one in the issuing office.
CRITICAL_FIELD_FLOORS = {
    "applicantName": 0.82,
    "guardianName": 0.82,
    "annualIncome": 0.85,
}


@pytest.fixture(scope="module")
def graded(request):
    """Every document read once, graded against the manifest's printed truth."""
    manifest = request.getfixturevalue("manifest")
    settings = request.getfixturevalue("settings")
    request.getfixturevalue("requires_tesseract")

    results = []
    for entry in manifest["documents"]:
        report = ocr.analyze(Image.open(CORPUS_ROOT / entry["file"]), settings)
        results.append(
            {
                "entry": entry,
                "report": report,
                "grades": grading.grade_document(entry["truth"], report.fields),
            }
        )
    return results


@pytest.mark.slow
class TestFieldAccuracy:
    def test_overall_accuracy_holds(self, graded):
        correct = sum(sum(r["grades"].values()) for r in graded)
        total = sum(len(r["grades"]) for r in graded)
        accuracy = correct / total

        assert accuracy >= FIELD_ACCURACY_FLOOR, (
            f"OCR field accuracy fell to {accuracy:.1%} ({correct}/{total}). "
            "If this is a deliberate trade-off, update the figure published in "
            "README.md — do not lower the floor to match."
        )

    @pytest.mark.parametrize("truth_key,floor", CRITICAL_FIELD_FLOORS.items())
    def test_fields_the_household_engine_depends_on(self, graded, truth_key, floor):
        correct = sum(1 for r in graded if r["grades"][truth_key])
        accuracy = correct / len(graded)
        assert accuracy >= floor, f"{truth_key} read correctly in {accuracy:.1%}"

    def test_no_field_is_completely_unreadable(self, graded):
        """A field at zero means the label anchor broke, not that OCR is noisy —
        a different class of bug, and one a per-field floor can miss if the
        overall average stays healthy."""
        for truth_key in grading.GRADED_FIELDS:
            correct = sum(1 for r in graded if r["grades"][truth_key])
            assert correct > 0, f"{truth_key} was never read correctly"


@pytest.mark.slow
class TestReadingIsHonestAboutItself:
    def test_confidence_is_reported_for_every_field_read(self, graded):
        for result in graded:
            for field in result["report"].fields.values():
                if field.value is not None:
                    assert field.confidence > 0.0

    def test_unread_fields_report_zero_confidence(self, graded):
        for result in graded:
            for field in result["report"].fields.values():
                if field.value is None:
                    assert field.confidence == 0.0

    def test_skew_is_corrected_within_the_search_window(self, graded, settings):
        for result in graded:
            assert abs(result["report"].skew_corrected_degrees) <= settings.max_skew_degrees

    def test_boxes_are_reported_in_page_coordinates(self, graded):
        """OCR runs on a 2x upscale; a caller drawing these on the original page
        must not have to know that."""
        for result in graded:
            image = Image.open(CORPUS_ROOT / result["entry"]["file"])
            for field in result["report"].fields.values():
                if field.box is None:
                    continue
                left, top, right, bottom = field.box
                assert 0 <= left < right <= image.width + 2
                assert 0 <= top < bottom <= image.height + 2


@pytest.mark.slow
class TestTamperedDocumentsAreReadAsPrinted:
    """
    A tampered certificate must be read as what it SAYS, not as what the
    applicant declared. The contradiction between the two is the signal, and
    it only exists if the reader reports the printed value faithfully.
    """

    def test_printed_income_is_recovered_on_tampered_documents(self, graded):
        tampered = [r for r in graded if r["entry"]["variant"] == "tampered"]
        assert tampered, "no tampered documents in the manifest"

        correct = sum(1 for r in tampered if r["grades"]["annualIncome"])
        assert correct / len(tampered) >= 0.75

    def test_reader_returns_the_forged_value_not_the_declared_one(self, graded):
        """The distinction that makes the OCR-versus-declared check possible."""
        for result in graded:
            entry = result["entry"]
            if entry["variant"] != "tampered":
                continue
            read = ocr.parse_income(result["report"].fields["annual_income"].value)
            if read is None:
                continue
            assert read != entry["declaredIncome"] or entry["declaredIncome"] == entry["renderedIncome"]


@pytest.mark.slow
class TestIncomeWordsCrossCheck:
    def test_figure_and_words_agree_on_genuine_documents(self, graded):
        """
        Where both are read, they must match — the renderer prints both from one
        value. Disagreement here is an OCR error, and the rate bounds how often
        the cross-check could fire spuriously on honest certificates.
        """
        genuine = [r for r in graded if r["entry"]["variant"] == "genuine"]
        comparable = [
            r for r in genuine if r["report"].income_words_mismatch is not None
        ]
        assert comparable, "no genuine document had both income forms readable"

        mismatches = sum(1 for r in comparable if r["report"].income_words_mismatch)
        assert mismatches / len(comparable) <= 0.20

    def test_the_cross_check_finds_nothing_on_this_corpus(self, graded):
        """
        HONEST CAVEAT, ASSERTED SO IT CANNOT BE FORGOTTEN.

        A figure/words mismatch is a real-world signal: a lazy forger edits the
        numeral and leaves the words contradicting it. This corpus's forger is
        not lazy — db/seed/tamper.ts repaints BOTH boxes with the forged value,
        so the two agree on every tampered document by construction.

        The check therefore detects zero tampering here, and any recall figure
        claimed for it would be describing a corpus that does not exist. It ships
        because the failure mode it targets is real, not because this corpus
        demonstrates it.
        """
        tampered = [r for r in graded if r["entry"]["variant"] == "tampered"]
        flagged = [r for r in tampered if r["report"].income_words_mismatch is True]

        # Any hit here is an OCR misread, not a detection.
        assert len(flagged) <= 0.20 * len(tampered)
