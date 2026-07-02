-- Migration 027: drop the legacy session_embeddings virtual table.
-- Migration 003 created it; migration 009 superseded it with the chunk + max-pool index.

DROP TABLE IF EXISTS session_embeddings;

INSERT OR IGNORE INTO schema_migrations (version, name)
  VALUES (27, '027_drop_legacy_session_embeddings');
