"""
Document-stage metrics over the synthetic corpus.

    .venv/Scripts/python scripts/corpus_metrics.py            # human readable
    .venv/Scripts/python scripts/corpus_metrics.py --json     # for metrics.ts

Set SCHOLARSHIELD_CORPUS_DIR to point at the corpus explicitly; metrics.ts uses
that to run this inside the OCR service image when there is no local venv.

Prints measurements, never targets. `apps/api/scripts/metrics.ts` spawns this
with --json and writes the result into the README, so nothing in the published
table is ever typed by hand.

Runs the modules directly rather than over HTTP: the numbers describe the
extraction and forensics code, and putting a web server in the path would only
add a way for the measurement to fail.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import pytesseract
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import forensics, grading, ocr  # noqa: E402
from app.config import get_settings  # noqa: E402

def _corpus_root() -> Path:
    """
    Where the generated corpus lives.

    Overridable because this script has two homes. Run from a checkout it sits
    four directories below the repository root; run inside the service image it
    sits at /srv/scripts, where that arithmetic walks off the top of the
    filesystem. The override is what lets the metrics run in the container that
    already carries Tesseract, instead of requiring it on the host.
    """
    override = os.environ.get("SCHOLARSHIELD_CORPUS_DIR")
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    return here.parents[3] / "db" / "seed" / "output"


CORPUS_ROOT = _corpus_root()

# A control document scoring at or above this counts as a false positive. Same
# threshold the reviewer UI would use to surface a region of interest.
FLAG_THRESHOLD = 0.5


def auc(positive: list[float], negative: list[float]) -> float:
    """Probability a random positive outranks a random negative. 0.5 is chance."""
    if not positive or not negative:
        return 0.5
    wins = 0.0
    for p in positive:
        for n in negative:
            wins += 1.0 if p > n else 0.5 if p == n else 0.0
    return wins / (len(positive) * len(negative))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="emit JSON only")
    args = parser.parse_args()

    manifest_path = CORPUS_ROOT / "manifest.json"
    if not manifest_path.exists():
        print(
            "corpus missing — run `npm run seed:documents` from the repo root",
            file=sys.stderr,
        )
        return 1

    settings = get_settings()
    if not settings.tesseract_available:
        print(f"tesseract not found at {settings.tesseract_cmd}", file=sys.stderr)
        return 1
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    documents = manifest["documents"]

    field_correct: dict[str, int] = {key: 0 for key in grading.GRADED_FIELDS}
    documents_fully_correct = 0
    page_confidences: list[float] = []
    scores_by_variant: dict[str, list[float]] = {}
    words_mismatch_flagged = {"tampered": 0, "genuine": 0}
    words_mismatch_comparable = {"tampered": 0, "genuine": 0}

    started = time.time()

    for entry in documents:
        # Older manifests were generated on Windows and carry backslashes, which
        # are ordinary filename characters on Linux rather than separators. The
        # generator now writes POSIX paths; this keeps a committed corpus from
        # before that change readable.
        path = CORPUS_ROOT / entry["file"].replace("\\", "/")
        image = Image.open(path)
        raw = path.read_bytes()

        extraction = ocr.analyze(image, settings)
        report = forensics.analyze(Image.open(path), raw, settings)

        grades = grading.grade_document(entry["truth"], extraction.fields)
        for key, ok in grades.items():
            field_correct[key] += 1 if ok else 0
        if all(grades.values()):
            documents_fully_correct += 1

        page_confidences.append(extraction.page_confidence)
        scores_by_variant.setdefault(entry["variant"], []).append(report.tamper_score)

        variant = entry["variant"]
        if variant in words_mismatch_comparable and extraction.income_words_mismatch is not None:
            words_mismatch_comparable[variant] += 1
            if extraction.income_words_mismatch:
                words_mismatch_flagged[variant] += 1

    elapsed = time.time() - started
    total_documents = len(documents)
    total_fields = total_documents * len(grading.GRADED_FIELDS)
    total_correct = sum(field_correct.values())

    tampered = scores_by_variant.get("tampered", [])
    control = scores_by_variant.get("control", [])
    control_false_positives = sum(1 for s in control if s >= FLAG_THRESHOLD)

    result = {
        "corpus": {
            "documents": total_documents,
            "genuine": len(scores_by_variant.get("genuine", [])),
            "tampered": len(tampered),
            "control": len(control),
            "secondsPerDocument": round(elapsed / max(1, total_documents), 2),
        },
        "ocr": {
            "fieldAccuracy": round(total_correct / total_fields, 4),
            "fieldsCorrect": total_correct,
            "fieldsTotal": total_fields,
            "documentsFullyCorrect": documents_fully_correct,
            "meanPageConfidence": round(statistics.mean(page_confidences), 4),
            "perField": {
                key: round(count / total_documents, 4)
                for key, count in field_correct.items()
            },
        },
        "ela": {
            # The headline number. Near 0.5 means the detector carries no signal
            # on this corpus — see PROJECT_REPORT.md §7.3 for why that is a
            # result rather than a defect.
            "tamperedVsControlAuc": round(auc(tampered, control), 4),
            "falsePositiveRate": round(control_false_positives / max(1, len(control)), 4),
            "falsePositives": control_false_positives,
            "controlCount": len(control),
            "meanTamperedScore": round(statistics.mean(tampered), 4) if tampered else 0.0,
            "meanControlScore": round(statistics.mean(control), 4) if control else 0.0,
            "flagThreshold": FLAG_THRESHOLD,
        },
        "incomeWordsCrossCheck": {
            # Zero by construction on this corpus: the tamper path repaints the
            # figure AND the words, so they agree. Published so the caveat
            # travels with the number.
            "tamperedFlagged": words_mismatch_flagged["tampered"],
            "tamperedComparable": words_mismatch_comparable["tampered"],
            "genuineFlagged": words_mismatch_flagged["genuine"],
            "genuineComparable": words_mismatch_comparable["genuine"],
        },
    }

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    ocr_block = result["ocr"]
    ela_block = result["ela"]

    print(f"corpus: {total_documents} documents, {result['corpus']['secondsPerDocument']}s/doc")
    print()
    print("OCR")
    print(f"  field accuracy         {ocr_block['fieldAccuracy']:.1%} "
          f"({ocr_block['fieldsCorrect']}/{ocr_block['fieldsTotal']})")
    print(f"  documents fully correct {documents_fully_correct}/{total_documents}")
    print(f"  mean page confidence   {ocr_block['meanPageConfidence']:.3f}")
    for key, value in ocr_block["perField"].items():
        print(f"    {key:<18} {value:.1%}")
    print()
    print("ELA")
    print(f"  tampered vs control AUC {ela_block['tamperedVsControlAuc']:.3f}  (0.5 = chance)")
    print(f"  false-positive rate     {ela_block['falsePositiveRate']:.1%} "
          f"({ela_block['falsePositives']}/{ela_block['controlCount']} controls)")
    print(f"  mean score tampered     {ela_block['meanTamperedScore']:.3f}")
    print(f"  mean score control      {ela_block['meanControlScore']:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
