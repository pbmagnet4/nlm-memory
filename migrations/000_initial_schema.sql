-- NLE Memory canonical store — SQLite schema
-- Default zero-config backend. Postgres mirror lives in schema/postgres.sql (TBD).
--
-- Design principles:
--   • Sessions are immutable once written — supersedence is via edges, never via UPDATE
--   • Entity registry is mutable (canonical merges, retitles, retirements)
--   • All timestamps are ISO 8601 strings in TEXT columns (SQLite lacks a native datetime type;
--     ISO strings sort correctly and are dialect-portable to Postgres)
--   • Foreign keys enforced; ON DELETE CASCADE only on edges, never on sessions

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ── Sessions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,           -- e.g. sess_2026-05-07T14-32-CAMEL
  runtime             TEXT NOT NULL,              -- e.g. claude-code/1.0, hermes/0.5
  runtime_session_id  TEXT,                       -- the runtime's own session identifier
  started_at          TEXT NOT NULL,              -- ISO 8601
  ended_at            TEXT,                       -- ISO 8601; NULL while session is active
  duration_min        INTEGER,                    -- computed; null while active
  label               TEXT NOT NULL,              -- human-readable session title
  summary             TEXT NOT NULL,              -- ~80-token classifier output
  body                TEXT,                       -- full markdown body with inline markers
  status              TEXT NOT NULL CHECK(status IN ('active','closed','superseded')),
  transcript_kind     TEXT,                       -- e.g. claude-code-jsonl
  transcript_path     TEXT,                       -- runtime-resolvable opaque pointer
  transcript_offset   INTEGER,                    -- byte offset start
  transcript_length   INTEGER,                    -- byte length
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_runtime ON sessions(runtime);

-- ── Entities ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  canonical           TEXT PRIMARY KEY,           -- preferred spelling — also the primary key
  type                TEXT NOT NULL,              -- 'candidate' until labeled. Built-in labels: project | tool | contact | service | concept. Custom labels are user-defined via the UI / `nle-daemon action label` and have no CHECK constraint.
  status              TEXT NOT NULL CHECK(status IN ('active','dormant','retired','rejected','candidate')),
  source              TEXT,                       -- e.g. 'property:.claude/properties/beacon.yaml', 'auto-detected', 'user-registered'
  notes               TEXT,                       -- freeform user notes
  first_seen_session  TEXT REFERENCES sessions(id),
  last_seen_session   TEXT REFERENCES sessions(id),
  session_count       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);

-- ── Entity variants (case-insensitive normalization) ───────────────────────
CREATE TABLE IF NOT EXISTS entity_variants (
  variant             TEXT PRIMARY KEY,           -- raw form as it appeared
  canonical           TEXT NOT NULL REFERENCES entities(canonical) ON DELETE CASCADE,
  source_session_id   TEXT REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_entity_variants_canonical ON entity_variants(canonical);

-- ── Session ↔ Entity (many-to-many) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_entities (
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entity_canonical    TEXT NOT NULL REFERENCES entities(canonical),
  PRIMARY KEY (session_id, entity_canonical)
);

CREATE INDEX IF NOT EXISTS idx_session_entities_entity ON session_entities(entity_canonical);

-- ── Markers (decisions / open questions) ──────────────────────────────────
-- Extracted from inline body markers. Body is canonical — these rows are a queryable cache.
CREATE TABLE IF NOT EXISTS markers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK(kind IN ('decision','open')),
  text                TEXT NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0  -- ordering within session
);

CREATE INDEX IF NOT EXISTS idx_markers_session ON markers(session_id);
CREATE INDEX IF NOT EXISTS idx_markers_kind ON markers(kind);

-- ── Supersedence + continues edges ────────────────────────────────────────
-- Edge table for non-destructive editing. A session can supersede or continue another.
-- Bidirectional lookups handled by indexes on both columns.
CREATE TABLE IF NOT EXISTS session_edges (
  from_session        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK(kind IN ('supersedes','continues','branched_from','merged_from')),
  PRIMARY KEY (from_session, to_session, kind)
);

CREATE INDEX IF NOT EXISTS idx_session_edges_from ON session_edges(from_session);
CREATE INDEX IF NOT EXISTS idx_session_edges_to ON session_edges(to_session);
CREATE INDEX IF NOT EXISTS idx_session_edges_kind ON session_edges(kind);

-- ── Full-text search over sessions ────────────────────────────────────────
-- FTS5 virtual table for label/summary/body search. Maintained via triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  label, summary, body,
  content='sessions',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, label, summary, body)
  VALUES (new.rowid, new.label, new.summary, new.body);
END;

CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, label, summary, body)
  VALUES('delete', old.rowid, old.label, old.summary, old.body);
  INSERT INTO sessions_fts(rowid, label, summary, body)
  VALUES (new.rowid, new.label, new.summary, new.body);
END;

CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, label, summary, body)
  VALUES('delete', old.rowid, old.label, old.summary, old.body);
END;

-- ── Vector embeddings (sqlite-vec) ────────────────────────────────────────
-- Loaded as an extension at runtime: SELECT load_extension('vec0');
-- Schema declared here for reference; real CREATE happens at daemon startup
-- after the extension is loaded.
--
-- CREATE VIRTUAL TABLE session_embeddings USING vec0(
--   session_id TEXT PRIMARY KEY,
--   embedding float[768]      -- nomic-embed-text dim; configurable
-- );

-- ── Schema migrations tracker ─────────────────────────────────────────────
-- Applied by SQLiteStore.migrate() on daemon start. Tracks which versioned
-- migration files in daemon/migrations/ have been run on this database.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Adapter state (per-runtime offsets for resumability) ──────────────────
CREATE TABLE IF NOT EXISTS adapter_state (
  adapter_name        TEXT NOT NULL,              -- e.g. 'claude-code'
  source_path         TEXT NOT NULL,              -- e.g. ~/.claude/projects/foo/abc123.jsonl
  last_offset         INTEGER NOT NULL DEFAULT 0,
  last_processed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (adapter_name, source_path)
);

-- ── Actions (event-sourced action log) ────────────────────────────────────
-- Universal primitive for every interactive change: alert dismiss/snooze, entity
-- retire, link supersedes/continues, mark intentional, undo, etc. Append-only.
-- Computed tables (session_edges, entities.status) become projections of this log.
-- Same schema across web UI, MCP tool calls, CLI, future mobile/api.
CREATE TABLE IF NOT EXISTS actions (
  id                  TEXT PRIMARY KEY,           -- act_<iso-ts>_<short-uuid>
  timestamp           TEXT NOT NULL,              -- ISO 8601 — when the action was taken
  kind                TEXT NOT NULL,              -- dismiss | snooze | retire_entity | label_entity | merge_entity | link_supersedes | link_continues | resolve_open | mark_intentional | undo | sync_localstorage
  subject_type        TEXT NOT NULL,              -- alert | entity | session | decision | open_question | action
  subject_id          TEXT NOT NULL,              -- e.g. 'stale_Squarespace', 'sess_002', 'NocoDB'
  payload             TEXT,                       -- JSON: action-specific data (snoozed_until, target_session_id, new_type, ...)
  actor               TEXT NOT NULL DEFAULT 'user', -- user | agent:claude-code | agent:hermes | system
  runtime             TEXT,                       -- web-ui | mcp:claude-code | cli | mobile-ios | api
  reverted_by         TEXT REFERENCES actions(id), -- the action that undid this one (null = active)
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_actions_subject ON actions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_actions_active ON actions(subject_type, subject_id, reverted_by) WHERE reverted_by IS NULL;
