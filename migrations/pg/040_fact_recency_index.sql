-- pg counterpart of sqlite migration 037: composite recency index for
-- tenant-scoped fact recall (M3, T1036).
CREATE INDEX IF NOT EXISTS idx_facts_tenant_created ON facts (tenant_id, created_at DESC);
