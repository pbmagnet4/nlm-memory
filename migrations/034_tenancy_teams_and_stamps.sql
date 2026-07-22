-- migrations/034_tenancy_teams_and_stamps.sql
-- M1 (Team NLM program spec §2): tenancy registry + tenant stamps.
-- sqlite lane: NOT NULL DEFAULT, no REFERENCES on ADD COLUMN (FKs enforced at
-- runtime; SQLite forbids ADD COLUMN + REFERENCES + non-NULL default).
-- Isolation is enforced at the store layer (M2), not by schema constraints.

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_tokens (
  token_hash TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_tokens_team ON team_tokens(team_id);

INSERT OR IGNORE INTO teams (id, name) VALUES ('team_local', 'Local operator team');

ALTER TABLE sessions       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE facts          ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE code_exemplars ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE signals        ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE workstreams    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE sources        ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';
ALTER TABLE providers      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'team_local';

CREATE INDEX IF NOT EXISTS idx_sessions_tenant       ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_facts_tenant          ON facts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_code_exemplars_tenant ON code_exemplars(tenant_id);
CREATE INDEX IF NOT EXISTS idx_signals_tenant        ON signals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_tenant    ON workstreams(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sources_tenant        ON sources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_providers_tenant      ON providers(tenant_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (34, 'tenancy_teams_and_stamps');
