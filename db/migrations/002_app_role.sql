-- Grant-level hardening. Run as a superuser.
--
-- 001 enforces the append-only audit log with triggers, which hold for every role.
-- This migration adds the grant-level control described in PROJECT_REPORT.md §4.4:
-- the role the application actually runs as holds no UPDATE or DELETE on audit_log.
--
-- Optional in local dev (where the app connects as the owner). Required in deploy —
-- set APP_DATABASE_URL to connect as scholarshield_app rather than the owner.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scholarshield_app') THEN
    CREATE ROLE scholarshield_app LOGIN PASSWORD 'scholarshield_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE scholarshield TO scholarshield_app;
GRANT USAGE ON SCHEMA public TO scholarshield_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO scholarshield_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO scholarshield_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO scholarshield_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO scholarshield_app;

-- The point of this file.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM scholarshield_app;
GRANT SELECT, INSERT ON audit_log TO scholarshield_app;

COMMIT;
