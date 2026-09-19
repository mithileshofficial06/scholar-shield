-- The OCR stage's own findings about a document, beside the fields it read.
--
-- The service has always reported whether the income printed in figures agrees
-- with the income written in words — the field a tamperer who edits one tends to
-- forget — along with the page's overall read confidence. The pipeline kept only
-- the extracted fields and dropped the rest, so that check never reached a rule
-- or a reviewer. Stored separately from extracted_fields so that column keeps
-- meaning exactly "the fields", which the reviewer's document panel iterates.

BEGIN;

ALTER TABLE documents ADD COLUMN ocr_report jsonb;

COMMIT;
