"""
HTTP surface.

The endpoints are thin, so what is worth testing is the boundary behaviour: that
malformed and hostile uploads are refused with a status the API's stage handler
can act on, and that nothing here ever returns a decision.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def jpeg_bytes(size=(400, 500), quality: int = 80) -> bytes:
    image = Image.new("RGB", size, (250, 249, 245))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


class TestHealth:
    def test_reports_tesseract_state_not_just_liveness(self, client):
        """
        A service that answers 200 while unable to read a character is worse
        than one that is down — the pipeline keeps feeding it and every document
        comes back empty.
        """
        response = client.get("/health")
        assert response.status_code == 200

        body = response.json()
        assert body["status"] in {"ok", "degraded"}
        assert "tesseract_available" in body
        assert body["tesseract_cmd"]
        # The two must agree: claiming ok without a resolvable binary is the
        # exact failure this endpoint exists to prevent.
        if body["status"] == "ok":
            assert body["tesseract_available"] is True


class TestUploadValidation:
    def test_empty_upload_is_rejected(self, client):
        response = client.post("/forensics", files={"file": ("x.jpg", b"", "image/jpeg")})
        assert response.status_code == 400

    def test_non_image_is_rejected_as_unsupported_media(self, client):
        """415 rather than 500: the API's stage handler must be able to tell a
        bad document from a broken service, because one is worth retrying."""
        response = client.post(
            "/forensics",
            files={"file": ("notes.txt", b"this is not an image at all", "text/plain")},
        )
        assert response.status_code == 415

    def test_truncated_jpeg_does_not_crash_the_service(self, client):
        truncated = jpeg_bytes()[:120]
        response = client.post(
            "/forensics", files={"file": ("cut.jpg", truncated, "image/jpeg")}
        )
        assert response.status_code in {400, 415}

    def test_oversized_upload_is_refused(self, client, settings):
        payload = b"\xff\xd8\xff" + b"\x00" * (settings.max_upload_bytes + 1)
        response = client.post(
            "/forensics", files={"file": ("big.jpg", payload, "image/jpeg")}
        )
        assert response.status_code == 413

    def test_missing_file_field_is_a_validation_error(self, client):
        assert client.post("/forensics").status_code == 422


class TestForensicsEndpoint:
    def test_returns_a_bounded_score_and_its_baseline(self, client):
        response = client.post(
            "/forensics", files={"file": ("page.jpg", jpeg_bytes(), "image/jpeg")}
        )
        assert response.status_code == 200

        body = response.json()
        assert 0.0 <= body["tamper_score"] <= 1.0
        assert "baseline_energy" in body
        assert body["encoding"]["format"] == "JPEG"

    def test_never_returns_a_verdict_field(self, client):
        """
        The service returns signals. A field called `fraudulent`, `verdict`, or
        `decision` appearing here would mean scoring had leaked out of the API,
        where the audit trail and the human requirement live.
        """
        response = client.post(
            "/forensics", files={"file": ("page.jpg", jpeg_bytes(), "image/jpeg")}
        )
        serialized = response.text.lower()
        for forbidden in ("verdict", "decision", "fraudulent", "approved", "rejected"):
            assert forbidden not in serialized


class TestAnalyzeEndpoint:
    def test_hashes_the_bytes_it_analysed(self, client):
        """
        The API stores the document and computes its own sha256; this one is how
        it confirms the bytes analysed are the bytes stored. The hash outlives
        the document itself in the audit trail (§10 retention), so a decision
        stays traceable to a specific file after that file is purged.
        """
        import hashlib

        payload = jpeg_bytes()
        response = client.post(
            "/analyze", files={"file": ("page.jpg", payload, "image/jpeg")}
        )
        assert response.status_code == 200

        body = response.json()
        assert body["sha256"] == hashlib.sha256(payload).hexdigest()
        assert body["byte_size"] == len(payload)

    def test_carries_both_reports(self, client, requires_tesseract):
        response = client.post(
            "/analyze", files={"file": ("page.jpg", jpeg_bytes(), "image/jpeg")}
        )
        body = response.json()
        assert "fields" in body["extraction"]
        assert "tamper_score" in body["forensics"]


class TestExtractEndpoint:
    def test_every_field_key_is_present_even_when_unreadable(
        self, client, requires_tesseract
    ):
        """A blank page must still answer with the full field set, all null —
        the API indexes these by name."""
        from app.ocr import FIELD_NAMES

        response = client.post(
            "/extract", files={"file": ("blank.jpg", jpeg_bytes(), "image/jpeg")}
        )
        assert response.status_code == 200

        fields = response.json()["fields"]
        assert set(fields) == set(FIELD_NAMES)
        assert all(field["value"] is None for field in fields.values())
