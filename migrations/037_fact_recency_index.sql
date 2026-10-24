-- Migration 037: composite recency index for tenant-scoped fact recall.
--
-- listForRecall always filters tenant_id and orders by created_at DESC with
-- a LIMIT (STORAGE_FETCH_CAP). Without this index the engine sorts the
-- filtered set on every recall call. M3 (T1036): index discipline.
CREATE INDEX IF NOT EXISTS idx_facts_tenant_created
  ON facts(tenant_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (37, '037_fact_recency_index');
