-- migrations/050_dream_settings.sql
-- Dreaming lane settings (T1729): the whole DreamSettings document as JSON,
-- one row for the daemon. Mirrors classifier_settings — the passes are one
-- process-global scheduler lane (POST /api/dreaming is a LOCAL-hosted control
-- plane), so there is no per-tenant switch to key a row on.
--
-- The document is written whole by the settings module on every accepted
-- update; a missing row means "nothing stored", and the NLM_DREAM_* env seed
-- wins. Shape validation lives in dream/settings.ts, never here.
CREATE TABLE IF NOT EXISTS dream_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  settings   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (50, '050_dream_settings');
