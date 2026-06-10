-- PG parity for SQLite migration 018: repair self-supersedence damage.
--
-- One-shot repair, applied manually by an operator against a PG canonical
-- store (PgStorage.init only runs 001_initial.sql, there is no version-gated
-- runner on the PG side). Mirrors migrations/018_repair_self_supersede.sql.
--
-- Removes self-loop 'supersedes' edges (id -> id) written by the unguarded
-- scan path, then restores sessions wrongly marked superseded — those left
-- without any real incoming 'supersedes' edge.

DELETE FROM session_edges WHERE from_session = to_session AND kind = 'supersedes';

UPDATE sessions
SET status = 'closed', updated_at = NOW()
WHERE status = 'superseded'
  AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'supersedes');
