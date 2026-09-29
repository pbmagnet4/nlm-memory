-- nlm:no-wrap
-- Add 'muse' to the sources.kind CHECK constraint. Without it, seedDefaults()
-- fails at boot on any machine with a Muse sessions directory. Table rebuild
-- under foreign_keys=OFF, carrying every column of the post-036 shape.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE sources_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('claude-code', 'codex', 'hermes', 'hermes-agent', 'muse', 'aider', 'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook')),
  name          TEXT    NOT NULL,
  path_or_url   TEXT,
  runtime_label TEXT    NOT NULL,
  parse_config  TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  token         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  tenant_id     TEXT    NOT NULL DEFAULT 'team_local',
  UNIQUE (tenant_id, name)
);
INSERT INTO sources_new (id, kind, name, path_or_url, runtime_label, parse_config, enabled, token, created_at, updated_at, tenant_id)
  SELECT id, kind, name, path_or_url, runtime_label, parse_config, enabled, token, created_at, updated_at, tenant_id FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_sources_tenant ON sources(tenant_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (38, 'sources_muse');
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
