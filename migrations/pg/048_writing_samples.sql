-- migrations/pg/048_writing_samples.sql
-- PG mirror of SQLite migration 051 (voice memory phase 1, piece A — T2438).
-- Idempotent: every DDL statement uses IF NOT EXISTS.
--
-- Same columns, indexes and CHECK constraints as the SQLite table; ts and
-- created_at stay TEXT so both backends hand the store the same string shape.

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
  tenant_id     TEXT NOT NULL REFERENCES teams(id),
  created_at    TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_writing_samples_scope_voice
  ON writing_samples(install_scope, voice, channel, outcome);

CREATE INDEX IF NOT EXISTS idx_writing_samples_hash
  ON writing_samples(install_scope, text_hash);

-- Vector lane (pgvector mirror of the sqlite-vec writing_samples_vec table),
-- at the prose lane's default dimension. ON DELETE CASCADE means a delete on
-- writing_samples cleans its vectors automatically — no separate vec
-- bookkeeping like the SQLite store.
CREATE TABLE IF NOT EXISTS writing_sample_embeddings (
  sample_id  TEXT PRIMARY KEY REFERENCES writing_samples(id) ON DELETE CASCADE,
  embedding  vector(768) NOT NULL
);

CREATE INDEX IF NOT EXISTS writing_sample_embeddings_idx
  ON writing_sample_embeddings USING ivfflat (embedding vector_l2_ops)
  WITH (lists = 100);
