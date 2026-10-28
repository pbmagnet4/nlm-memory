-- Daemon-wide embedder settings, one row per lane ('prose' | 'code'). A NULL
-- column means "not set" and falls back to env, then the built-in default.
-- api_key is write-only through the API (never returned or logged).
CREATE TABLE IF NOT EXISTS embedder_settings (
  lane       TEXT PRIMARY KEY CHECK (lane IN ('prose', 'code')),
  provider   TEXT,
  base_url   TEXT,
  model      TEXT,
  api_key    TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
