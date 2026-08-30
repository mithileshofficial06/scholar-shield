"""
Value parsing. No OCR, no corpus — these run everywhere and in milliseconds.

The parsers are where a misread turns into a wrong *number*, which is the more
dangerous failure: a garbled name is visibly garbled to a reviewer, whereas an
income silently off by a factor of ten looks like a declaration.
"""

from __future__ import annotations

import pytest

from app.ocr import parse_family_size, parse_income, parse_income_words


class TestParseIncome:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Rs. 1,78,000/-", 178_000),
            ("Rs 178000", 178_000),
            ("Rs. 76,000/", 76_000),
            ("₹ 2,50,000/-", 250_000),
            ("  Rs.  91,500 /-  ", 91_500),
        ],
    )
    def test_reads_indian_formatting(self, raw, expected):
        assert parse_income(raw) == expected

    def test_stops_at_the_solidus(self):
        """`/-` is a suffix, not digits. Absorbing it gives 7600 from 76,000/-."""
        assert parse_income("Rs. 76,000/-") == 76_000

    @pytest.mark.parametrize("raw", [None, "", "Rs. ", "not a number", "-"])
    def test_returns_none_rather_than_guessing(self, raw):
        assert parse_income(raw) is None

    @pytest.mark.parametrize("raw", ["Rs. 12/-", "Rs. 999999999999/-"])
    def test_rejects_values_outside_a_plausible_band(self, raw):
        """A household income of 12 rupees is a misread, and returning it would
        drive a contradiction rule against an applicant who declared correctly."""
        assert parse_income(raw) is None


class TestParseIncomeWords:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("One Lakh Seventy Eight Thousand Rupees Only", 178_000),
            ("Seventy Six Thousand Rupees Only", 76_000),
            ("Two Lakh Fifty Thousand Rupees Only", 250_000),
            ("Ninety One Thousand Five Hundred Rupees Only", 91_500),
            ("Eighty Eight Thousand Rupees Only", 88_000),
        ],
    )
    def test_reads_indian_scale_words(self, raw, expected):
        assert parse_income_words(raw) == expected

    def test_lakh_closes_the_group_before_it(self):
        """`Two Lakh Fifty Thousand` is 2,50,000 — not 2 * 50,000 and not
        100,000 * 50,000. Getting this wrong makes the figure/words
        cross-check fire on every correct certificate."""
        assert parse_income_words("Two Lakh Fifty Thousand") == 250_000

    def test_is_case_insensitive_and_ignores_punctuation(self):
        assert parse_income_words("(seventy-six thousand rupees only)") == 76_000

    @pytest.mark.parametrize("raw", [None, "", "Rupees Only", "%%%"])
    def test_returns_none_when_no_number_is_present(self, raw):
        assert parse_income_words(raw) is None


class TestParseFamilySize:
    @pytest.mark.parametrize("raw,expected", [("5", 5), (" 4 ", 4), ("12", 12)])
    def test_reads_a_count(self, raw, expected):
        assert parse_family_size(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "many", "0", "99"])
    def test_rejects_impossible_counts(self, raw):
        assert parse_family_size(raw) is None


class TestFigureAndWordsAgree:
    """
    The renderer prints both forms from one value, so a correct read of a
    correct certificate must produce equal numbers. This is the property the
    income_words_mismatch signal depends on.
    """

    @pytest.mark.parametrize(
        "figure,words",
        [
            ("Rs. 1,78,000/-", "One Lakh Seventy Eight Thousand Rupees Only"),
            ("Rs. 88,000/-", "Eighty Eight Thousand Rupees Only"),
            ("Rs. 2,50,000/-", "Two Lakh Fifty Thousand Rupees Only"),
            ("Rs. 91,500/-", "Ninety One Thousand Five Hundred Rupees Only"),
        ],
    )
    def test_parsers_agree_on_the_same_amount(self, figure, words):
        assert parse_income(figure) == parse_income_words(words)
