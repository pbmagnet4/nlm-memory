-- Migration 044: composite recency index for tenant-scoped fact recall.
--
-- listForRecall always filters tenant_id and orders by created_at DESC with
-- a LIMIT (STORAGE_FETCH_CAP). Without this index the engine sorts the
-- filtered set on every recall call. M3 (T1036): index discipline.
--
-- Repair note: this index first shipped as 037_fact_recency_index, but a
-- parallel track landed 037_sessions_covering_index under the same version,
-- so DBs that recorded version 37 never created it. This re-issue under a
-- fresh version applies the index everywhere. CREATE INDEX IF NOT EXISTS
-- keeps double-application (fresh DBs running both 037 files) harmless.
CREATE INDEX IF NOT EXISTS idx_facts_tenant_created
  ON facts(tenant_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (44, '044_fact_recency_index');
