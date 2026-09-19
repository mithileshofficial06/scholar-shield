-- One application per person, per applicant account, per cycle.
--
-- Submission is public and a browser can send it twice: a double click, a
-- resubmitted form after a refresh, a retry on a slow network. Each of those used
-- to create a second application for the same student, which then resolved into
-- a household with itself and could flag its own duplicate.
--
-- Keyed on the applicant's name as well as the account because siblings often
-- apply under one parent's email address; that is legitimate and must still
-- work. The name is compared case- and whitespace-insensitively so "Priya
-- Ramesh" and "priya  ramesh " are one person. Enforced here rather than only in
-- the route, because two concurrent requests would both pass a check-then-insert.

BEGIN;

CREATE UNIQUE INDEX applications_one_per_person_idx
  ON applications (applicant_id, cycle, lower(regexp_replace(btrim(applicant_name), '\s+', ' ', 'g')));

COMMIT;
