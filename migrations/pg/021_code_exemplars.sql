-- PG parity for SQLite migration 021: code_exemplars lane.
--
-- Mirrors migrations/021_code_exemplars.sql. Uses pgvector `vector(768)`
-- instead of sqlite-vec `vec0`. Applied manually by an operator.

BEGIN;

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
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass','fail','fix','exhausted')),
  git_sha       TEXT,
  survived      SMALLINT,
  ts            TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exemplars_scope_repo
  ON code_exemplars(install_scope, repo, outcome);

CREATE INDEX IF NOT EXISTS idx_exemplars_ts
  ON code_exemplars(ts);

CREATE INDEX IF NOT EXISTS idx_exemplars_code_hash
  ON code_exemplars(install_scope, code_hash);

-- Vector lane. 768 dims matches CodeRankEmbed-137M output.
CREATE TABLE IF NOT EXISTS code_exemplars_vec (
  exemplar_id  TEXT PRIMARY KEY,
  embedding    vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS code_exemplars_vec_embedding_idx
  ON code_exemplars_vec USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 10);

COMMIT;
