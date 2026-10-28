-- Daemon-wide classifier tuning (thinking mode, per-call timeout, output-token
-- budget). One row; a NULL column means "not set" and falls back to env, then
-- the built-in default.
CREATE TABLE IF NOT EXISTS classifier_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  thinking   TEXT CHECK (thinking IN ('off', 'on')),
  timeout_ms INTEGER,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL
);
