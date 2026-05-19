-- Migration 004: facts + fact_embeddings.
--
-- Facts are the agent-recall projection of session content: normalized
-- (subject, predicate, value) triples derived from session classifier output,
-- supersedence-aware via the tombstone pointer `superseded_by`. See
-- docs/plans/factstore-design.md.
--
-- Phase B.1 creates the tables. Writes start in Phase B.2 (classifier prompt
-- extension). The fact_embeddings vec0 table is created now so Phase B.3 can
-- light up semantic fact recall without a second migration.

CREATE TABLE IF NOT EXISTS facts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('decision', 'open', 'attribute')),
  subject            TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  value              TEXT NOT NULL,
  source_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_quote       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_by      TEXT REFERENCES facts(id) ON DELETE SET NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

-- Hot path: deterministic supersedence collision check on ingest
-- (subject, predicate) lookups against current rows only.
CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate_current
  ON facts(subject, predicate)
  WHERE superseded_by IS NULL;

-- "What do we know about X?" — subject-only browsing.
CREATE INDEX IF NOT EXISTS idx_facts_subject_current
  ON facts(subject)
  WHERE superseded_by IS NULL;

-- Reverse lookup: which facts came from this session?
CREATE INDEX IF NOT EXISTS idx_facts_session
  ON facts(source_session_id);

-- Semantic recall index (Phase B.3). 768 dims matches nomic-embed-text.
CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings USING vec0(
  fact_id    TEXT PRIMARY KEY,
  embedding  float[768]
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (4, '004_facts');
