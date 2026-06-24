-- migrations/025_workstreams.sql
-- Workstream abstraction (#367) Plan A: a persistent container a session binds
-- to at end-of-session. See docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md.

CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY,           -- ws_<uuid>
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','retired')),
  merged_into     TEXT REFERENCES workstreams(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_session_at TEXT
);

CREATE TABLE IF NOT EXISTS workstream_entities (
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical),
  session_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, entity_canonical)
);

CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity ON workstream_entities(entity_canonical);

ALTER TABLE sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id);
ALTER TABLE sessions ADD COLUMN binding_source TEXT;
ALTER TABLE sessions ADD COLUMN binding_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (25, 'workstreams');
