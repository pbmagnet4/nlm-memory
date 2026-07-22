-- nlm:no-wrap
-- migrations/036_tenant_name_uniqueness.sql
-- M4 (Team NLM program spec §5 row M4): sources.name / providers.name
-- uniqueness re-keyed from a single-column UNIQUE to (tenant_id, name), so
-- two teams can register same-named sources/providers while a name still
-- stays unique within one tenant. SQLite can't ALTER a column-level UNIQUE
-- constraint, so this is a table rebuild under foreign_keys=OFF (precedent:
-- migrations/019_split_replaces.sql, 033_actions_kind_check.sql,
-- 035_tenancy_entity_rekey.sql). Every current column carried over exactly
-- (verified against the live schema, incl. the 034-added tenant_id).

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE sources_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('claude-code', 'codex', 'hermes', 'hermes-agent', 'aider', 'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook')),
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

CREATE TABLE providers_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL CHECK (kind IN ('deepseek', 'ollama', 'openai', 'anthropic', 'openrouter', 'openai-compatible')),
  name          TEXT    NOT NULL,
  base_url      TEXT,
  api_key       TEXT,
  default_model TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  tenant_id     TEXT    NOT NULL DEFAULT 'team_local',
  UNIQUE (tenant_id, name)
);
INSERT INTO providers_new (id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at, tenant_id)
  SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at, tenant_id FROM providers;
DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;
CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers(enabled) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_providers_tenant ON providers(tenant_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (36, 'tenant_name_uniqueness');
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
