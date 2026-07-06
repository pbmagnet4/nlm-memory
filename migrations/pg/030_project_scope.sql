-- migrations/pg/030_project_scope.sql
-- PG parity for SQLite migration 029 (project scope). Auto-applied by the
-- version-gated runner (runMigrationsPg). Idempotent: every DDL uses
-- ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS. Mirrors migrations/029_project_scope.sql.

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope);

ALTER TABLE facts ADD COLUMN IF NOT EXISTS scope TEXT;
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);

ALTER TABLE code_exemplars ADD COLUMN IF NOT EXISTS scope TEXT;
CREATE INDEX IF NOT EXISTS idx_code_exemplars_scope ON code_exemplars(scope);

ALTER TABLE signals ADD COLUMN IF NOT EXISTS scope TEXT;
CREATE INDEX IF NOT EXISTS idx_signals_scope ON signals(scope);

ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS scope TEXT;
CREATE INDEX IF NOT EXISTS idx_workstreams_scope ON workstreams(scope);

COMMIT;
