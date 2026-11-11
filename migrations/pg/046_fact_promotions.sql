-- PG mirror of SQLite 049 (T1611): dream promotion pass nominations.
-- A row is one nominated fact; demotion marks demoted_at + demote_reason and
-- keeps the row as the link — never deleted.
CREATE TABLE IF NOT EXISTS fact_promotions (
  fact_id       TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL DEFAULT 'team_local',
  promoted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score         DOUBLE PRECISION NOT NULL,
  reason        TEXT NOT NULL,
  demoted_at    TIMESTAMPTZ,
  demote_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_fact_promotions_active
  ON fact_promotions(tenant_id)
  WHERE demoted_at IS NULL;
