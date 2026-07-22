-- migrations/pg/035_tenant_name_uniqueness.sql
-- M4 (Team NLM program spec §5 row M4): sources.name / providers.name
-- uniqueness re-keyed from a single-column UNIQUE constraint to
-- (tenant_id, name), so two teams can register same-named sources/providers
-- while a name still stays unique within one tenant. Constraint names
-- verified against the live schema: sources_name_key / providers_name_key
-- (the default names Postgres assigns to an inline `name TEXT ... UNIQUE`).

ALTER TABLE sources   DROP CONSTRAINT IF EXISTS sources_name_key;
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_name_key;

ALTER TABLE sources   ADD CONSTRAINT sources_tenant_name_key   UNIQUE (tenant_id, name);
ALTER TABLE providers ADD CONSTRAINT providers_tenant_name_key UNIQUE (tenant_id, name);

INSERT INTO schema_migrations (version, name) VALUES (35, 'tenant_name_uniqueness') ON CONFLICT DO NOTHING;
