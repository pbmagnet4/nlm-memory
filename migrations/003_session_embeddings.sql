-- Migration 003: session_embeddings virtual table via sqlite-vec.
--
-- Requires sqlite-vec loaded at connection time (handled by SQLiteStore.connect()).
-- 768 dims matches nomic-embed-text, the default embedding model.

CREATE VIRTUAL TABLE IF NOT EXISTS session_embeddings USING vec0(
  session_id TEXT PRIMARY KEY,
  embedding  float[768]
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (3, '003_session_embeddings');
