-- nlm:no-wrap
-- migrations/035_tenancy_entity_rekey.sql
-- M1 (Team NLM program spec §2): entities become tenant-local. Composite PK
-- (tenant_id, canonical); referencing tables re-keyed with composite FKs.
-- Table rebuild per the 010-015/033 convention: FKs off, own transaction.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE entities_new (
  tenant_id           TEXT NOT NULL DEFAULT 'team_local',
  canonical           TEXT NOT NULL,
  type                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('active','dormant','retired','rejected','candidate')),
  source              TEXT,
  notes               TEXT,
  first_seen_session  TEXT REFERENCES sessions(id),
  last_seen_session   TEXT REFERENCES sessions(id),
  session_count       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, canonical)
);
INSERT INTO entities_new (tenant_id, canonical, type, status, source, notes, first_seen_session, last_seen_session, session_count, created_at, updated_at)
  SELECT 'team_local', canonical, type, status, source, notes, first_seen_session, last_seen_session, session_count, created_at, updated_at FROM entities;
DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;
CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);

CREATE TABLE entity_variants_new (
  tenant_id           TEXT NOT NULL DEFAULT 'team_local',
  variant             TEXT NOT NULL,
  canonical           TEXT NOT NULL,
  source_session_id   TEXT REFERENCES sessions(id),
  PRIMARY KEY (tenant_id, variant),
  FOREIGN KEY (tenant_id, canonical) REFERENCES entities(tenant_id, canonical) ON DELETE CASCADE
);
INSERT INTO entity_variants_new (tenant_id, variant, canonical, source_session_id)
  SELECT 'team_local', variant, canonical, source_session_id FROM entity_variants;
DROP TABLE entity_variants;
ALTER TABLE entity_variants_new RENAME TO entity_variants;
CREATE INDEX IF NOT EXISTS idx_entity_variants_canonical ON entity_variants(tenant_id, canonical);

CREATE TABLE session_entities_new (
  tenant_id           TEXT NOT NULL DEFAULT 'team_local',
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entity_canonical    TEXT NOT NULL,
  PRIMARY KEY (session_id, entity_canonical),
  FOREIGN KEY (tenant_id, entity_canonical) REFERENCES entities(tenant_id, canonical)
);
INSERT INTO session_entities_new (tenant_id, session_id, entity_canonical)
  SELECT 'team_local', session_id, entity_canonical FROM session_entities;
DROP TABLE session_entities;
ALTER TABLE session_entities_new RENAME TO session_entities;
CREATE INDEX IF NOT EXISTS idx_session_entities_entity ON session_entities(tenant_id, entity_canonical);

CREATE TABLE workstream_entities_new (
  tenant_id        TEXT NOT NULL DEFAULT 'team_local',
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  entity_canonical TEXT NOT NULL,
  session_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, entity_canonical),
  FOREIGN KEY (tenant_id, entity_canonical) REFERENCES entities(tenant_id, canonical)
);
INSERT INTO workstream_entities_new (tenant_id, workstream_id, entity_canonical, session_count)
  SELECT 'team_local', workstream_id, entity_canonical, session_count FROM workstream_entities;
DROP TABLE workstream_entities;
ALTER TABLE workstream_entities_new RENAME TO workstream_entities;
CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity ON workstream_entities(tenant_id, entity_canonical);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (35, 'tenancy_entity_rekey');
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
