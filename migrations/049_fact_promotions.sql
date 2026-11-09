-- migrations/049_fact_promotions.sql
-- Dream promotion pass (T1611) nominations: which facts the offline dream
-- lane currently nominates for pointer-block injection.
--
-- A row is one nominated fact. Promotion is explicit and capped (the pass
-- enforces MAX lines / bytes across active rows); demotion never deletes:
-- demoted_at + demote_reason mark the row out of the injected set while the
-- row itself survives as the link explaining what was promoted and why it
-- was withdrawn — the fact-supersedence "mark explicitly, never erase" rule
-- applied to nominations.
-- DERIVE-VIA-FK: read only through facts.
CREATE TABLE IF NOT EXISTS fact_promotions (
  fact_id       TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL DEFAULT 'team_local',
  promoted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  score         REAL NOT NULL,
  reason        TEXT NOT NULL,
  demoted_at    TEXT,
  demote_reason TEXT
);

-- Active (injected-set) promotions per tenant.
CREATE INDEX IF NOT EXISTS idx_fact_promotions_active
  ON fact_promotions(tenant_id)
  WHERE demoted_at IS NULL;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (49, '049_fact_promotions');
