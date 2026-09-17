-- migrations/037_sessions_covering_index.sql
-- Covering index so joins that only need a session's id/tenant/started_at stop
-- reading the row itself.
--
-- `sessions` carries `body`, which is the bulk of the store (378MB of a 1.45GB
-- database on the reference install). Any plan that resolves a session by id
-- through sqlite_autoindex_sessions_1 then visits the main b-tree and pays for
-- that whole wide row. The entity-overlap lookup in the ingest path does
-- exactly this, once per candidate: 10ms warm but 5,190ms cold, hit repeatedly
-- on boot, inside a synchronous better-sqlite3 call that blocks the event loop
-- (NLM #457 — same class of problem as the correlated LIKE fixed in
-- core/actions/actions-log.ts, different query).
--
-- With this index the planner reports
--   SEARCH s USING COVERING INDEX idx_sessions_cover_id_tenant_started (id=? AND tenant_id=?)
-- and never touches the main table. Roughly 1MB for 15k sessions.
--
-- Column order is (id, tenant_id, started_at): id is the join/seek key,
-- tenant_id the equality filter, started_at trails so it is available for
-- ORDER BY without a lookup.

CREATE INDEX IF NOT EXISTS idx_sessions_cover_id_tenant_started
  ON sessions(id, tenant_id, started_at);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (37, 'sessions_covering_index');
