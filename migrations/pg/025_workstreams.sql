-- migrations/pg/025_workstreams.sql
-- PG parity for SQLite migration 025 (workstreams). Auto-applied by the
-- version-gated runner (runMigrationsPg). Idempotent: every DDL statement uses
-- IF NOT EXISTS or ADD COLUMN IF NOT EXISTS, so re-applying on an existing
-- schema is a no-op. Mirrors migrations/025_workstreams.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
  merged_into     TEXT REFERENCES workstreams(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_session_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workstream_entities (
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical),
  session_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, entity_canonical)
);

CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity ON workstream_entities(entity_canonical);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workstream_id TEXT REFERENCES workstreams(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS binding_source TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS binding_confidence DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);

COMMIT;
