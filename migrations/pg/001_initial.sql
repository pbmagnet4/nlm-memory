-- NLM PostgreSQL schema v1.
-- Mirrors SQLite migrations/000–016 but uses PG idioms:
--   - SERIAL / TEXT for PKs (no AUTOINCREMENT)
--   - pgvector for embeddings instead of sqlite-vec
--   - tsvector generated column + GIN for FTS5 equivalent
--   - NOW() instead of datetime('now')
--   - ON CONFLICT DO NOTHING / DO UPDATE instead of INSERT OR IGNORE / REPLACE

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Sessions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  runtime              TEXT NOT NULL,
  runtime_session_id   TEXT,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  duration_min         REAL,
  label                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  body                 TEXT,
  status               TEXT NOT NULL CHECK (status IN ('active', 'closed', 'superseded')),
  transcript_kind      TEXT,
  transcript_path      TEXT,
  transcript_offset    BIGINT,
  transcript_length    BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workstream_id        TEXT,
  binding_source       TEXT,
  binding_confidence   DOUBLE PRECISION,
  fts_vector           TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(label, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS sessions_fts_idx ON sessions USING GIN(fts_vector);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- ── Session embeddings (chunks + map, mirrors SQLite architecture) ──────────
CREATE TABLE IF NOT EXISTS session_embedding_chunks (
  chunk_id   SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_idx  INTEGER NOT NULL,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_chunks_embedding_idx
  ON session_embedding_chunks USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS session_chunk_map (
  chunk_id   INTEGER NOT NULL REFERENCES session_embedding_chunks(chunk_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_idx  INTEGER NOT NULL,
  PRIMARY KEY (chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_session_chunk_map_session ON session_chunk_map(session_id);

-- ── Markers (decisions + open questions) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS markers (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('decision', 'open')),
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_markers_session ON markers(session_id);

-- ── Entities ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  canonical          TEXT PRIMARY KEY,
  type               TEXT NOT NULL DEFAULT 'candidate',
  status             TEXT NOT NULL DEFAULT 'candidate',
  source             TEXT NOT NULL DEFAULT 'auto-detected',
  first_seen_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  last_seen_session  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_entities (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entity_canonical  TEXT NOT NULL REFERENCES entities(canonical) ON DELETE CASCADE,
  PRIMARY KEY (session_id, entity_canonical)
);

-- ── Session edges ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_edges (
  from_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('supersedes', 'continues')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_session, to_session, kind)
);

-- ── Facts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS facts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('decision', 'open', 'attribute')),
  subject            TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  value              TEXT NOT NULL,
  source_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_quote       TEXT,
  created_at         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  superseded_by      TEXT REFERENCES facts(id) ON DELETE SET NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  -- Operator retirement marker (mirror of SQLite migration 022). Non-null =
  -- an operator declared the fact wrong/noise; recall excludes it like a
  -- superseded fact, but getHistory still surfaces it for the audit trail.
  retired_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate_current
  ON facts(subject, predicate) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_subject_current
  ON facts(subject) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_session
  ON facts(source_session_id);

-- ── Fact embeddings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id    TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS fact_embeddings_idx
  ON fact_embeddings USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);

-- ── Actions (event-sourced action log) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS actions (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      TEXT,
  actor        TEXT NOT NULL DEFAULT 'user',
  runtime      TEXT,
  reverted_by  TEXT REFERENCES actions(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actions_subject ON actions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp DESC);

-- ── Sources registry ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'hermes', 'hermes-agent', 'aider', 'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook')),
  name           TEXT NOT NULL UNIQUE,
  path_or_url    TEXT,
  runtime_label  TEXT NOT NULL,
  parse_config   TEXT NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  token          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Providers registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('deepseek', 'ollama', 'openai', 'anthropic', 'openrouter', 'openai-compatible')),
  name           TEXT NOT NULL UNIQUE,
  base_url       TEXT,
  api_key        TEXT,
  default_model  TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Adapter state (per-runtime offsets for resumability) ─────────────────────
CREATE TABLE IF NOT EXISTS adapter_state (
  adapter_name       TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  last_offset        BIGINT NOT NULL DEFAULT 0,
  last_processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_size          BIGINT,
  session_id         TEXT,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (adapter_name, source_path)
);

-- ── Schema migrations tracker ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name) VALUES (1, '001_initial')
  ON CONFLICT DO NOTHING;

-- Signals - agent self-improvement telemetry lane (mirror of SQLite 017).
CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  v             INTEGER NOT NULL DEFAULT 1,
  install_scope TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('gate', 'eval', 'review', 'test')),
  producer      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'fix', 'exhausted')),
  model         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  step          TEXT,
  detail        TEXT,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_signals_agg ON signals(install_scope, repo, model, kind, step);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

-- ── Code exemplars (mirror of SQLite migration 021) ─────────────────────────
-- Sibling to signals: concrete code chunks with deterministic outcome labels
-- for the recall_code lane. Append-only on id, no supersedence. Gated behind
-- NLM_CODE_EXEMPLARS_ENABLED in the application layer; tables created
-- unconditionally so the schema stays backend-symmetric.
CREATE TABLE IF NOT EXISTS code_exemplars (
  id            TEXT PRIMARY KEY,
  install_scope TEXT NOT NULL,
  signal_id     TEXT,
  session_id    TEXT,
  repo          TEXT NOT NULL,
  model         TEXT NOT NULL,
  lang          TEXT,
  task_context  TEXT NOT NULL,
  code          TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'fix', 'exhausted')),
  git_sha       TEXT,
  survived      INTEGER,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (now()::text),
  retired_at    TEXT,
  label_source  TEXT NOT NULL DEFAULT 'llm'
);
CREATE INDEX IF NOT EXISTS idx_exemplars_scope_repo ON code_exemplars(install_scope, repo, outcome);
CREATE INDEX IF NOT EXISTS idx_exemplars_ts ON code_exemplars(ts);
CREATE INDEX IF NOT EXISTS idx_exemplars_code_hash ON code_exemplars(install_scope, code_hash);

-- Vector lane (pgvector mirror of the sqlite-vec code_exemplars_vec table).
-- ON DELETE CASCADE means prune/cap deletes on code_exemplars clean the
-- embeddings automatically — no separate vec bookkeeping like the SQLite store.
CREATE TABLE IF NOT EXISTS code_exemplar_embeddings (
  exemplar_id TEXT PRIMARY KEY REFERENCES code_exemplars(id) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL
);
CREATE INDEX IF NOT EXISTS code_exemplar_embeddings_idx
  ON code_exemplar_embeddings USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);

-- ── Workstreams (mirror of SQLite migration 025) ─────────────────────────────
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

-- FK from sessions.workstream_id to workstreams (deferred so workstreams exists first)
ALTER TABLE sessions
  ADD CONSTRAINT IF NOT EXISTS fk_sessions_workstream
  FOREIGN KEY (workstream_id) REFERENCES workstreams(id);

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);
