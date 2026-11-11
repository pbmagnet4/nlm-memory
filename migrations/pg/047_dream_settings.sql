-- PG mirror of SQLite 050 (T1729): dreaming lane settings, the whole
-- DreamSettings document as JSON in one daemon-wide row (the passes are one
-- process-global scheduler lane, so nothing is keyed per tenant here).
-- A missing row means "nothing stored" and the NLM_DREAM_* env seed wins.
CREATE TABLE IF NOT EXISTS dream_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  settings   JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
