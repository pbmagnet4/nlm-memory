-- migrations/041_fact_embed_pending.sql
-- Durable record of fact embeddings that failed or were shed (T732 / E1).
-- A fact row is committed before its vector is computed, so an embedder error
-- used to leave the fact keyword-only with nothing to remember it. A row here
-- is one such fact, with retry bookkeeping for the daemon sweep. Cleared when
-- the vector is written. DERIVE-VIA-FK: read only through facts.
CREATE TABLE IF NOT EXISTS fact_embed_pending (
  fact_id         TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
