-- One row per household edge, not two.
--
-- UNIQUE (application_a_id, application_b_id, match_field) treated A→B and
-- B→A as different edges, and reconciliation stored each pair in whatever
-- order the cycle's rows happened to come back. Every run that saw a different
-- order added the reversed twin, so a reviewer saw each match twice — and
-- rejecting one left its twin looking active.
--
-- From here the pair is stored smaller id first (household/service.ts), and a
-- CHECK makes any other order impossible. Existing data is folded first:
-- a rejection recorded on either twin is kept, since a reviewer's decision is
-- the one thing here that must not be lost.

BEGIN;

UPDATE household_edges c
   SET rejected_at = r.rejected_at,
       rejected_by = r.rejected_by,
       rejected_reason = r.rejected_reason
  FROM household_edges r
 WHERE c.application_a_id < c.application_b_id
   AND r.application_a_id = c.application_b_id
   AND r.application_b_id = c.application_a_id
   AND r.match_field = c.match_field
   AND r.rejected_at IS NOT NULL
   AND c.rejected_at IS NULL;

DELETE FROM household_edges r
 USING household_edges c
 WHERE r.application_a_id > r.application_b_id
   AND c.application_a_id = r.application_b_id
   AND c.application_b_id = r.application_a_id
   AND c.match_field = r.match_field;

UPDATE household_edges
   SET application_a_id = application_b_id,
       application_b_id = application_a_id
 WHERE application_a_id > application_b_id;

ALTER TABLE household_edges
  ADD CONSTRAINT household_edges_canonical_order CHECK (application_a_id < application_b_id);

COMMIT;
