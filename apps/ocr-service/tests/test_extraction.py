"""
Label-anchored extraction, tested against synthetic line structures rather than
images.

Every case here is a misread that actually happened while building the reader
(see the rules documented in ocr._find_label). Reproducing them as line
fixtures keeps them fast and keeps them honest: they assert the *rule*, not a
particular JPEG.
"""

from __future__ import annotations

from app.ocr import Line, Word, extract_fields, group_lines


def word(text: str, left: int, line: int, confidence: float = 90.0) -> Word:
    """A word on a notional line, 20px tall, roughly 11px per character."""
    return Word(
        text=text,
        left=left,
        top=line * 40,
        width=max(10, len(text) * 11),
        height=20,
        confidence=confidence,
        line_key=(1, 1, 1, line),
    )


def line_of(texts: list[str], line: int, start: int = 70) -> Line:
    words = []
    cursor = start
    for text in texts:
        w = word(text, cursor, line)
        words.append(w)
        cursor += w.width + 8
    return Line(words=tuple(words))


class TestLabelAnchoring:
    def test_district_is_not_taken_from_the_page_header(self):
        """
        The masthead reads "TAMIL NADU e-DISTRICT — SIMULATED", and "e-DISTRICT"
        scores 0.94 against the "District" label. Without the line-start anchor
        the District field extracted "— SIMULATED" from the header, on every
        document in the corpus.
        """
        lines = [
            line_of(["TAMIL", "NADU", "e-DISTRICT", "-", "SIMULATED"], 0),
            line_of(["District", "Erode"], 1),
        ]
        fields = extract_fields(lines)
        assert fields["district"].value == "Erode"

    def test_recovers_a_field_whose_label_lost_a_word(self):
        """Tesseract routinely reads "Members in Family" as "Members in"."""
        lines = [line_of(["Members", "in", "5"], 0)]
        fields = extract_fields(lines)
        assert fields["family_size"].value == "5"

    def test_short_labels_do_not_accept_a_dropped_token(self):
        """
        "PIN" is a 0.80 match for the "in" of "(in words)". Allowing a
        one-of-two-token match made the income-in-words field extract the PIN
        code — from a line that appears earlier on the page, so it won.
        """
        lines = [
            line_of(["PIN", "Code", "638001"], 0),
            line_of(["(in", "words)", "Seventy", "Six", "Thousand"], 1),
        ]
        fields = extract_fields(lines)
        assert fields["pincode"].value == "638001"
        assert fields["annual_income_words"].value == "Seventy Six Thousand"

    def test_strongest_match_wins_over_the_earliest(self):
        """A weak match higher up the page must not claim a field that a later
        line matches exactly."""
        lines = [
            line_of(["Address", "18", "Gandhi", "Road"], 0),
            line_of(["Name", "of", "Applicant", "Praveen", "Kumar"], 1),
        ]
        fields = extract_fields(lines)
        assert fields["applicant_name"].value == "Praveen Kumar"
        assert fields["address"].value == "18 Gandhi Road"

    def test_label_end_is_excluded_from_the_value(self):
        lines = [line_of(["Father", "/", "Guardian", "Shankar", "Duraisamy"], 0)]
        fields = extract_fields(lines)
        assert fields["guardian_name"].value == "Shankar Duraisamy"


class TestTwoFieldsOnOneLine:
    def test_certificate_number_stops_before_the_issue_date(self):
        lines = [
            line_of(
                ["Certificate", "No.", "TN-ERD-2026-120334", "Date", "of",
                 "Issue:", "2026-05-11"],
                0,
            )
        ]
        fields = extract_fields(lines)
        assert fields["certificate_id"].value == "TN-ERD-2026-120334"

    def test_issue_date_is_found_mid_line(self):
        lines = [
            line_of(
                ["Certificate", "No.", "TN-ERD-2026-120334", "Date", "of",
                 "Issue:", "2026-05-11"],
                0,
            )
        ]
        fields = extract_fields(lines)
        assert fields["issue_date"].value == "2026-05-11"


class TestIssuingOffice:
    def test_reads_the_line_below_its_label(self):
        """The one field printed under its label rather than beside it."""
        lines = [
            line_of(["Issuing", "Authority"], 0),
            line_of(["Erode", "Taluk", "Office"], 1),
        ]
        fields = extract_fields(lines)
        assert fields["issuing_office"].value == "Erode Taluk Office"

    def test_tolerates_a_misread_label(self):
        """Tesseract reads "Issuing" as "fssuing" on roughly a tenth of the
        corpus — the leading capital I is the least reliable glyph on the page."""
        lines = [
            line_of(["fssuing", "Authority"], 0),
            line_of(["Tambaram", "Taluk", "Office"], 1),
        ]
        fields = extract_fields(lines)
        assert fields["issuing_office"].value == "Tambaram Taluk Office"


class TestMissingFields:
    def test_absent_fields_are_none_not_empty_string(self):
        """
        An empty string reads downstream as "the certificate states nothing
        here", which is a claim. None is the absence of a reading.
        """
        fields = extract_fields([line_of(["Nothing", "useful", "here"], 0)])
        assert fields["applicant_name"].value is None
        assert fields["applicant_name"].confidence == 0.0
        assert fields["applicant_name"].box is None

    def test_every_declared_field_is_always_present_as_a_key(self):
        """Callers index these by name; a missing key is an AttributeError in
        the API's stage handler rather than a low-confidence field."""
        from app.ocr import FIELD_NAMES

        fields = extract_fields([])
        assert set(fields) == set(FIELD_NAMES)


class TestLineGrouping:
    def test_words_are_ordered_left_to_right_within_a_line(self):
        scrambled = [word("Nagar", 300, 0), word("Address", 70, 0), word("2", 220, 0)]
        lines = group_lines(scrambled)
        assert lines[0].text == "Address 2 Nagar"

    def test_lines_are_ordered_down_the_page(self):
        words = [word("second", 70, 5), word("first", 70, 1)]
        lines = group_lines(words)
        assert [line.text for line in lines] == ["first", "second"]
