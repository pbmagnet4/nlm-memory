-- migrations/pg/034_tenancy.sql
-- M1 (Team NLM program spec §2): tenancy registry, tenant stamps with full
-- constraint rigor (the hosted lane), entity re-key to (tenant_id, canonical).

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_tokens (
  token_hash TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_tokens_team ON team_tokens(team_id);

INSERT INTO teams (id, name) VALUES ('team_local', 'Local operator team') ON CONFLICT DO NOTHING;

-- Stamp the seven flat tables: add → backfill → NOT NULL → FK → index.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','facts','code_exemplars','signals','workstreams','sources','providers'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', t);
    EXECUTE format('UPDATE %I SET tenant_id = ''team_local'' WHERE tenant_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT ''team_local''', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS fk_%s_tenant', t, t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT fk_%s_tenant FOREIGN KEY (tenant_id) REFERENCES teams(id)', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant ON %I(tenant_id)', t, t);
  END LOOP;
END $$;

-- Entity re-key: stamp the four entity-graph tables, then swap keys.
ALTER TABLE entities            ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE entity_variants     ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE session_entities    ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE workstream_entities ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE entities            SET tenant_id = 'team_local' WHERE tenant_id IS NULL;
UPDATE entity_variants     SET tenant_id = 'team_local' WHERE tenant_id IS NULL;
UPDATE session_entities    SET tenant_id = 'team_local' WHERE tenant_id IS NULL;
UPDATE workstream_entities SET tenant_id = 'team_local' WHERE tenant_id IS NULL;
ALTER TABLE entities            ALTER COLUMN tenant_id SET DEFAULT 'team_local';
ALTER TABLE entity_variants     ALTER COLUMN tenant_id SET DEFAULT 'team_local';
ALTER TABLE session_entities    ALTER COLUMN tenant_id SET DEFAULT 'team_local';
ALTER TABLE workstream_entities ALTER COLUMN tenant_id SET DEFAULT 'team_local';
ALTER TABLE entities            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE entity_variants     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE session_entities    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE workstream_entities ALTER COLUMN tenant_id SET NOT NULL;

-- Drop the old single-column FKs (default constraint names from 001/025/029),
-- then the old PKs, then rebuild composite.
ALTER TABLE session_entities    DROP CONSTRAINT IF EXISTS session_entities_entity_canonical_fkey;
ALTER TABLE workstream_entities DROP CONSTRAINT IF EXISTS workstream_entities_entity_canonical_fkey;
ALTER TABLE entity_variants     DROP CONSTRAINT IF EXISTS entity_variants_canonical_fkey;
ALTER TABLE entities            DROP CONSTRAINT IF EXISTS entities_pkey;
ALTER TABLE entities            ADD PRIMARY KEY (tenant_id, canonical);
ALTER TABLE entities            ADD CONSTRAINT fk_entities_tenant FOREIGN KEY (tenant_id) REFERENCES teams(id);

ALTER TABLE entity_variants DROP CONSTRAINT IF EXISTS entity_variants_pkey;
ALTER TABLE entity_variants ADD PRIMARY KEY (tenant_id, variant);
ALTER TABLE entity_variants ADD CONSTRAINT fk_entity_variants_entity
  FOREIGN KEY (tenant_id, canonical) REFERENCES entities(tenant_id, canonical) ON DELETE CASCADE;

ALTER TABLE session_entities ADD CONSTRAINT fk_session_entities_entity
  FOREIGN KEY (tenant_id, entity_canonical) REFERENCES entities(tenant_id, canonical);
ALTER TABLE workstream_entities ADD CONSTRAINT fk_workstream_entities_entity
  FOREIGN KEY (tenant_id, entity_canonical) REFERENCES entities(tenant_id, canonical);

CREATE INDEX IF NOT EXISTS idx_entity_variants_canonical     ON entity_variants(tenant_id, canonical);
CREATE INDEX IF NOT EXISTS idx_session_entities_entity_t     ON session_entities(tenant_id, entity_canonical);
CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity_t  ON workstream_entities(tenant_id, entity_canonical);

INSERT INTO schema_migrations (version, name) VALUES (34, 'tenancy') ON CONFLICT DO NOTHING;
