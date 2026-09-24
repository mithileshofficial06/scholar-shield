-- Staff deactivation, session revocation, and applicant email confirmation.
--
-- STAFF
-- An admin could invite a reviewer and never remove one: a person who left the
-- committee kept a working password, and any session they held stayed valid
-- until it expired. `deactivated_at` refuses the account at sign-in, and
-- `session_version` is stamped into every staff token and compared on every
-- request, so bumping it (deactivation, or "sign out everywhere") kills every
-- session already issued rather than waiting out the TTL.
--
-- APPLICANTS
-- Submission is public, so anyone could file an application under any address
-- and — by declaring a sibling with a different income — raise a real
-- applicant's score. A public submission now starts unconfirmed and takes no
-- part in household resolution or the contradiction rules until the address it
-- names has clicked the link sent to it.
--
-- The column DEFAULTS to now() on purpose: every row that did not come through
-- the public form (the seeder, an admin CSV import, rows that already exist) is
-- treated as confirmed. Only the public submission route writes NULL.

BEGIN;

ALTER TABLE users
  ADD COLUMN deactivated_at  timestamptz,
  ADD COLUMN session_version integer NOT NULL DEFAULT 0;

ALTER TABLE applicants
  ADD COLUMN email_confirmed_at timestamptz DEFAULT now();

COMMIT;
