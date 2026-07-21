-- migrations/pg/032_session_derivables.sql
-- PG parity for SQLite migration 032 (session derivables). Auto-applied by
-- the version-gated runner (runMigrationsPg). Idempotent: every DDL uses
-- ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS. Mirrors
-- migrations/032_session_derivables.sql. All nullable: NULL means
-- not-derivable for that runtime, never faked.

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_persona TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS primary_model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS skill TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

COMMIT;
