-- Optional TOTP for staff accounts (PROJECT_REPORT.md §10).
--
-- The report has listed "password + optional TOTP" since it was written, and
-- only the password half existed. This adds the other half.
--
-- The secret is stored recoverably because verification needs the same bytes the
-- authenticator app holds; it cannot be hashed. Recovery codes carry no such
-- constraint, so they are hashed like passwords and live in their own table --
-- a leaked database gives up TOTP secrets and nothing about recovery codes.
--
-- totp_last_step is what makes a code single-use. A code is valid for its 30s
-- step and one either side, which is also a 90-second replay window; refusing
-- any step at or below the last one spent closes it.

BEGIN;

-- users.totp_secret has existed since 001_init.sql: the column was provisioned
-- when the schema was written and nothing ever read or wrote it. Only the two
-- columns that make it usable are new.
ALTER TABLE users
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step  bigint;

-- Enrolment is not complete until a code has been verified, so a half-finished
-- enrolment (secret issued, never confirmed) must never gate a login.
ALTER TABLE users
  ADD CONSTRAINT users_totp_enabled_needs_secret
  CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL);

CREATE TABLE totp_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- sha256 of the normalised code. Never the code itself.
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX totp_recovery_user_idx ON totp_recovery_codes (user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX totp_recovery_hash_idx ON totp_recovery_codes (user_id, code_hash);

COMMIT;
