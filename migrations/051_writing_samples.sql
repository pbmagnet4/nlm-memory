-- Migration 051: writing_samples — voice-recall lane (T2438 phase 1, piece A).
--
-- Sibling to code_exemplars: concrete prose the person already published or
-- approved, so agents can pull "how do I write like this person" at drafting
-- time. Append-only on a deterministic id, no supersedence, no LLM in the
-- labelling loop (the outcome is what the consumer says happened to the text).
--
-- Gated behind NLM_VOICE_ENABLED=1 (default off). The tables are created
-- unconditionally so migrations stay idempotent and rollback is trivial; the
-- flag gates the ingest/recall paths in the application layer.
--
-- STAMP table: tenant_id NOT NULL DEFAULT 'team_local', no REFERENCES (see the
-- 034 header). install_scope is stamped server-side by the store, never taken
-- from a caller (design invariant 1). `context` is provenance for a human
-- reader only — it is never embedded, so a reply's prompt cannot pull an
-- unrelated sample into recall.

CREATE TABLE IF NOT EXISTS writing_samples (
  id            TEXT PRIMARY KEY,       -- sha256(install_scope|voice|channel|text_hash|source)[:16]
  install_scope TEXT NOT NULL,
  voice         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  audience      TEXT,
  source        TEXT NOT NULL CHECK (source IN ('published','approved','import','onboarding')),
  source_ref    TEXT,                   -- URL or upstream record id; provenance only
  text          TEXT NOT NULL,          -- the person's words only
  text_hash     TEXT NOT NULL,          -- sha256 of the normalised text
  context       TEXT,                   -- what it replied to; never embedded
  outcome       TEXT NOT NULL CHECK (outcome IN ('published','approved','rejected','pending_review')),
  draft_id      TEXT,
  session_id    TEXT,
  rules_version TEXT,
  ts            TEXT NOT NULL,          -- when it was written or published
  tenant_id     TEXT NOT NULL DEFAULT 'team_local',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recall hot path: scope + voice + channel, narrowed by outcome.
CREATE INDEX IF NOT EXISTS idx_writing_samples_scope_voice
  ON writing_samples(install_scope, voice, channel, outcome);

-- Dedup check: the id already covers this tuple, so the index serves the
-- importer's "have we seen this text in this install" probe.
CREATE INDEX IF NOT EXISTS idx_writing_samples_hash
  ON writing_samples(install_scope, text_hash);

-- Vector lane for semantic voice recall. 768 dims is the prose lane's default
-- (nomic-embed-text — same width as session_embedding_chunks / fact_embeddings,
-- a different space from code_exemplars_vec). A prose embedder at another dim
-- gets the table dropped and recreated at the probed dim, the way
-- src/core/exemplars/embed-backfill.ts does for the code lane.
-- Graceful degradation: with no embedder configured samples still land in
-- writing_samples; only the semantic search path is unavailable.
CREATE VIRTUAL TABLE IF NOT EXISTS writing_samples_vec USING vec0(
  sample_id TEXT PRIMARY KEY,
  embedding float[768]
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (51, '051_writing_samples');
