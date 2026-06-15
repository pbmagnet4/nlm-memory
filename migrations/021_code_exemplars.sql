-- Migration 021: code_exemplars — code-exemplar recall lane.
--
-- Sibling to signals: stores concrete code chunks with deterministic outcome
-- labels so agents can pull "what code passed/failed a gate like this" at
-- implementation time. Append-only on id, no supersedence, no LLM in the
-- labeling loop (outcome comes from git-survival + test exit code).
--
-- Gated behind NLM_CODE_EXEMPLARS_ENABLED=1 (default off). The tables are
-- created unconditionally so migrations stay idempotent; the feature flag
-- controls ingest and retrieval paths in the application layer.

CREATE TABLE IF NOT EXISTS code_exemplars (
  id            TEXT PRIMARY KEY,       -- sha256(install_scope|repo|code_hash|outcome)[:16]
  install_scope TEXT NOT NULL,
  signal_id     TEXT,                   -- soft link to signals.id (may be null)
  session_id    TEXT,                   -- soft link to the originating session
  repo          TEXT NOT NULL,
  model         TEXT NOT NULL,          -- model that produced the code (any vendor)
  lang          TEXT,                   -- detected language (ts, py, go, ...)
  task_context  TEXT NOT NULL,          -- one/two lines: what this code was for
  code          TEXT NOT NULL,          -- the chunk (hunk / function / file slice)
  code_hash     TEXT NOT NULL,          -- sha256 of normalised code, for dedup
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass','fail','fix','exhausted')),
  git_sha       TEXT,                   -- commit the chunk landed in, if known
  survived      INTEGER,               -- nullable; lazily filled (1=lived, 0=reverted)
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Aggregation / recall hot path: scope + repo + outcome-class filter.
CREATE INDEX IF NOT EXISTS idx_exemplars_scope_repo
  ON code_exemplars(install_scope, repo, outcome);

-- Retention prune: cap-eviction scan and optional clock-based prune.
CREATE INDEX IF NOT EXISTS idx_exemplars_ts
  ON code_exemplars(ts);

-- Dedup check: same code_hash in the same scope is a no-op on insert.
CREATE INDEX IF NOT EXISTS idx_exemplars_code_hash
  ON code_exemplars(install_scope, code_hash);

-- Vector lane for semantic code search. 768 dims matches CodeRankEmbed-137M
-- (same width as nomic-embed-text, different space — lanes never share).
-- Graceful degradation: if no code embedder is configured, exemplars still
-- land in code_exemplars; only the semantic search path is unavailable.
CREATE VIRTUAL TABLE IF NOT EXISTS code_exemplars_vec USING vec0(
  exemplar_id TEXT PRIMARY KEY,
  embedding   float[768]
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (21, '021_code_exemplars');
