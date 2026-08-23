-- ScholarShield — initial schema
--
-- Design notes that matter:
--   * audit_log is append-only, enforced by trigger so it holds for every role
--     including the owner (see 002_app_role.sql for grant-level hardening too).
--   * applications carry normalized_* columns; these are what entity resolution
--     matches on, and they carry trigram GIN indexes for pg_trgm similarity.
--   * risk_flags stamp rule_id + rule_config_version so a historical score is
--     always reproducible against the config that produced it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums

CREATE TYPE user_role AS ENUM ('reviewer', 'admin');

CREATE TYPE application_status AS ENUM (
  'submitted',      -- received, pipeline not finished
  'processing',     -- pipeline running
  'ready_for_review',
  'approved',
  'escalated',
  'rejected'
);

CREATE TYPE review_decision AS ENUM ('approve', 'escalate', 'reject');

CREATE TYPE verification_status AS ENUM (
  'manual_check_required',  -- default and, in v1, the shipped path
  'verified',
  'mismatch',
  'unavailable'
);

CREATE TYPE document_kind AS ENUM ('income_certificate', 'supporting');

CREATE TYPE flag_severity AS ENUM ('low', 'medium', 'high');

CREATE TYPE pipeline_stage AS ENUM (
  'ocr_extract',
  'forensics_analyze',
  'verification_check',
  'household_reconcile',
  'risk_score'
);

CREATE TYPE stage_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead_lettered');

-- ---------------------------------------------------------------- users

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  role          user_role NOT NULL DEFAULT 'reviewer',
  password_hash text,
  password_salt text,
  totp_secret   text,
  invited_by    uuid REFERENCES users (id),
  invite_token  text,
  invite_expires_at timestamptz,
  activated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_invite_token_key ON users (invite_token) WHERE invite_token IS NOT NULL;

-- ---------------------------------------------------------------- applicants

CREATE TABLE applicants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  full_name  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX applicants_email_key ON applicants (lower(email));

-- Passwordless magic-link auth for applicants. Tokens are stored hashed.
CREATE TABLE magic_link_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX magic_link_tokens_hash_key ON magic_link_tokens (token_hash);
CREATE INDEX magic_link_tokens_applicant_idx ON magic_link_tokens (applicant_id);

-- ---------------------------------------------------------------- applications

CREATE TABLE applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  cycle        text NOT NULL,
  status       application_status NOT NULL DEFAULT 'submitted',

  -- Declared by the applicant at submission.
  applicant_name          text NOT NULL,
  guardian_name           text NOT NULL,
  guardian_phone          text,
  address_line            text NOT NULL,
  district                text NOT NULL,
  pincode                 text,
  declared_annual_income  bigint NOT NULL CHECK (declared_annual_income >= 0),
  declared_family_size    smallint NOT NULL CHECK (declared_family_size BETWEEN 1 AND 30),
  certificate_id          text,
  issuing_office          text,
  certificate_issue_date  date,

  -- Normalized forms — what entity resolution actually compares (§5 Tier 1).
  normalized_applicant_name text,
  normalized_guardian_name  text,
  normalized_address        text,
  normalized_phone          text,

  household_id uuid,
  risk_score   numeric(6,2) NOT NULL DEFAULT 0,
  scored_at    timestamptz,

  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX applications_applicant_idx ON applications (applicant_id);
CREATE INDEX applications_status_idx ON applications (status);
CREATE INDEX applications_cycle_idx ON applications (cycle);
CREATE INDEX applications_household_idx ON applications (household_id);
-- Risk queue ordering.
CREATE INDEX applications_queue_idx ON applications (status, risk_score DESC, submitted_at ASC);
-- Certificate reuse across applicants is a collision worth indexing for.
CREATE INDEX applications_certificate_idx ON applications (certificate_id) WHERE certificate_id IS NOT NULL;

-- Trigram indexes: these are what make fuzzy household resolution practical.
CREATE INDEX applications_norm_guardian_trgm ON applications USING gin (normalized_guardian_name gin_trgm_ops);
CREATE INDEX applications_norm_applicant_trgm ON applications USING gin (normalized_applicant_name gin_trgm_ops);
CREATE INDEX applications_norm_address_trgm ON applications USING gin (normalized_address gin_trgm_ops);
CREATE INDEX applications_norm_phone_idx ON applications (normalized_phone) WHERE normalized_phone IS NOT NULL;

-- ---------------------------------------------------------------- documents

CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  kind           document_kind NOT NULL DEFAULT 'income_certificate',

  storage_key    text NOT NULL,      -- object storage key; never a public URL
  content_type   text NOT NULL,
  byte_size      bigint NOT NULL,
  sha256         text NOT NULL,      -- survives document purge for the audit trail

  extracted_fields  jsonb,           -- OCR output, with per-field confidence
  forensics         jsonb,           -- ELA + metadata report
  tamper_score      numeric(5,4),
  ela_heatmap_key   text,

  purged_at      timestamptz,        -- set by the retention job
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_application_idx ON documents (application_id);
CREATE INDEX documents_sha256_idx ON documents (sha256);

-- ---------------------------------------------------------------- pipeline state

-- One row per (document, stage). The unique constraint is what makes the
-- BullMQ handlers idempotent under at-least-once delivery.
CREATE TABLE pipeline_stage_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  stage        pipeline_stage NOT NULL,
  status       stage_status NOT NULL DEFAULT 'pending',
  attempts     smallint NOT NULL DEFAULT 0,
  last_error   text,
  result       jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, stage)
);

CREATE INDEX pipeline_stage_runs_status_idx ON pipeline_stage_runs (status);

-- ---------------------------------------------------------------- households

CREATE TABLE households (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle          text NOT NULL,
  member_count   integer NOT NULL DEFAULT 0,
  last_resolved_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE applications
  ADD CONSTRAINT applications_household_fk
  FOREIGN KEY (household_id) REFERENCES households (id) ON DELETE SET NULL;

-- An edge is evidence that two applications may share a household. Weighted,
-- with the matched field recorded so the reviewer can see and reject the merge.
CREATE TABLE household_edges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_a_id    uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  application_b_id    uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  match_field         text NOT NULL,   -- guardian_name | address | phone | applicant_name
  similarity          numeric(5,4) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  weight              numeric(5,4) NOT NULL,
  rejected_by         uuid REFERENCES users (id),
  rejected_reason     text,
  rejected_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (application_a_id <> application_b_id),
  UNIQUE (application_a_id, application_b_id, match_field)
);

CREATE INDEX household_edges_a_idx ON household_edges (application_a_id);
CREATE INDEX household_edges_b_idx ON household_edges (application_b_id);

-- ---------------------------------------------------------------- verification

CREATE TABLE verification_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  adapter           text NOT NULL,     -- ManualLinkAdapter | MockStateAdapter
  status            verification_status NOT NULL DEFAULT 'manual_check_required',
  manual_check_url  text NOT NULL,     -- always generated; the shipped path
  checked_by        uuid REFERENCES users (id),
  checked_at        timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_results_application_idx ON verification_results (application_id);

-- ---------------------------------------------------------------- risk flags

CREATE TABLE risk_flags (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  rule_id              text NOT NULL,
  rule_config_version  text NOT NULL,
  severity             flag_severity NOT NULL,
  weight               numeric(6,2) NOT NULL,
  -- Human-readable, shown verbatim to the reviewer. Never a bare number.
  reason               text NOT NULL,
  -- The exact field values that triggered it, for the "why" drill-down.
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Re-running the pipeline must not duplicate flags (idempotency).
  UNIQUE (application_id, rule_id, rule_config_version)
);

CREATE INDEX risk_flags_application_idx ON risk_flags (application_id);
CREATE INDEX risk_flags_rule_idx ON risk_flags (rule_id);

-- ---------------------------------------------------------------- reviews

CREATE TABLE reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  reviewer_id    uuid NOT NULL REFERENCES users (id),
  decision       review_decision NOT NULL,
  -- A typed reason is structurally required. This is the guardrail, not policy text.
  reason         text NOT NULL CHECK (length(btrim(reason)) >= 10),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reviews_application_idx ON reviews (application_id);
CREATE INDEX reviews_reviewer_idx ON reviews (reviewer_id);

-- ---------------------------------------------------------------- tips

CREATE TABLE tips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES applications (id) ON DELETE CASCADE,
  body           text NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 2000),
  -- Hashed, never the raw address. Retained only for rate limiting and abuse review.
  submitter_ip_hash text NOT NULL,
  marked_abusive_by uuid REFERENCES users (id),
  marked_abusive_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tips_application_idx ON tips (application_id);
CREATE INDEX tips_ip_hash_idx ON tips (submitter_ip_hash, created_at);

-- ---------------------------------------------------------------- audit log

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,                 -- null for system actions
  actor_type   text NOT NULL,        -- user | applicant | system
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Append-only, enforced in the database rather than in application code.
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------- updated_at

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_touch BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
