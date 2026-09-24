# ocr-service

OCR extraction and document forensics for ScholarShield. Stateless: bytes in, report out.

It is a separate process in a separate language for one reason — it is where untrusted uploads get parsed. Tesseract and Pillow are large C surfaces pointed at files a stranger supplied, so they run here, isolated, with no database credentials and nothing writable. It never stores a document, never learns which application a document belongs to, and has no concept of a risk score.

**It returns signals, never decisions.** A test asserts that no response body contains the words `verdict`, `decision`, `fraudulent`, `approved`, or `rejected`.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Reports whether Tesseract actually resolved, not just that the process is up |
| `POST /extract` | Label-anchored field extraction |
| `POST /forensics` | ELA + encoding metadata |
| `POST /analyze` | Both, plus the sha256 of the analysed bytes |

`/extract` and `/forensics` are separate so the API's pipeline can retry one stage without paying for the other.

## Running it

Docker is the easy path — `docker compose -f infra/docker-compose.yml up -d` builds and starts it with Tesseract already installed.

Locally:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # .venv/bin/python on macOS/Linux
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

Tesseract itself is a system binary, not a wheel:

- **Windows** — `winget install UB-Mannheim.TesseractOCR`. The installer does **not** add it to `PATH`, which is why `OCR_TESSERACT_CMD` exists; the default already points at `C:\Program Files\Tesseract-OCR\tesseract.exe`.
- **Debian/Ubuntu** — `apt install tesseract-ocr tesseract-ocr-eng`
- **macOS** — `brew install tesseract`

Check it resolved:

```bash
curl localhost:8000/health
```

`"status": "degraded"` means the service is up but cannot read a character. That distinction matters — a service answering 200 while reading nothing is worse than one that is down, because the pipeline keeps feeding it.

## Configuration

Every setting is an environment variable prefixed `OCR_` (see `app/config.py`). The ones worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `OCR_TESSERACT_CMD` | platform-dependent | Path to the binary |
| `OCR_TESSERACT_PSM` | `6` | Page segmentation. `3` splits the seal and watermark into their own blocks and reorders lines, which breaks label anchoring |
| `OCR_MAX_SKEW_DEGREES` | `6.0` | Skew search window |
| `OCR_ELA_QUALITY` | `90` | Fixed: ELA is only comparable across documents differenced at one quality |
| `OCR_MAX_UPLOAD_BYTES` | `12582912` | 12 MB |

## Tests

```bash
.venv/Scripts/python -m pytest              # fast suite
.venv/Scripts/python -m pytest -m slow      # corpus suite, needs npm run seed:documents
.venv/Scripts/python -m pytest -m ""        # everything
```

The corpus suite is deselected by default because it runs OCR over all 67 documents and takes minutes. Published metrics come from `npm run metrics` at the repo root, not from the tests — the tests assert floors so a regression fails loudly instead of quietly lowering a number in the README.

## How extraction works

Label-anchored, not coordinate-anchored. Nothing in `app/ocr.py` knows a coordinate: each field is found by locating its printed label and taking the words to the right of it on the same line. Extraction by fixed offsets would score near-perfectly on the synthetic corpus and collapse on any real certificate, making the published accuracy a measurement of the renderer rather than the reader.

Before Tesseract sees a page it is deskewed (projection-profile variance) and preprocessed (flat-field, 2× Lanczos upscale). That is not polish — on the raw degraded corpus Tesseract reads at 0.62 mean confidence and finds 71 of ~110 words; after preprocessing, 0.94 and 107. Label anchoring depends on "same line, to the right of" being a meaningful statement, and at 3° of skew across a 900px page the right edge of a line sits below the left edge by more than a line height.

Measured field accuracy on the degraded corpus: **92.5%** (620/670), 47 of 67 documents fully correct.

## A note on ELA

Error Level Analysis measures *inconsistent compression history*, not dishonesty. Every caveat follows from that.

On this corpus it carries **no usable signal**: AUC 0.510 against matched controls, where 0.5 is chance. That is a measured negative result rather than an unfinished feature, and the control group in `db/seed/tamper.ts` exists precisely so it could be detected instead of assumed. The reason is in that file — the tamper path re-encodes through a different library than the detector expects, and degradation then re-compresses the whole page on top of the edit at a *lower* quality than the edit itself, erasing the local history.

`tests/test_forensics.py` asserts the AUC stays near chance. If a future detector genuinely separates the groups, that test fails and the README figure must be updated — the assertion locks the measurement to the code, and deleting it would let the published number drift.

The figure/words cross-check has a related caveat: a lazy forger edits the numeral and leaves the amount-in-words contradicting it, but this corpus's forger repaints both, so the check detects zero tampering here by construction. It ships because the failure mode is real, not because this corpus demonstrates it.
