-- Durable record of session chunks whose embedding failed. A session row is
-- committed before its chunks are embedded, so an embedder error used to leave
-- that chunk missing until the session was re-ingested. A row here is one such
-- chunk, with retry bookkeeping for the daemon sweep. Cleared when the vector
-- is written; a row at the attempt cap stays so `nlm doctor` can report it.
CREATE TABLE IF NOT EXISTS chunk_embed_pending (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_idx       INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, chunk_idx)
);
