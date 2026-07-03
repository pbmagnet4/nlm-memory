-- Entity variant alias table. Tracks merged surface forms so re-ingest of an
-- old spelling binds to the canonical entity instead of resurrecting the source.
CREATE TABLE IF NOT EXISTS entity_variants (
  variant           TEXT PRIMARY KEY,
  canonical         TEXT NOT NULL REFERENCES entities(canonical) ON DELETE CASCADE,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_variants_canonical ON entity_variants(canonical);
