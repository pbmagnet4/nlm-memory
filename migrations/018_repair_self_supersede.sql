-- Migration 018: repair self-supersedence damage.
--
-- The SQLite scanOnce path set supersedes = prior.session_id with no self-id
-- guard. Adapter session ids are deterministic, so a resumed (grown) transcript
-- re-ingested under the SAME id and insertSession wrote a self-loop edge
-- (id -> id, 'supersedes') then flipped that same row to status='superseded'.
-- Result: a session that supersedes itself and is marked superseded with no
-- real successor. The code fix guards both the scan path and insertSession;
-- this migration repairs rows already damaged.

DELETE FROM session_edges WHERE from_session = to_session AND kind = 'supersedes';

-- Restore sessions wrongly marked superseded: a legitimately superseded row
-- keeps a real incoming 'supersedes' edge (some other session -> it). Rows with
-- no remaining incoming edge were only self-superseded and should be 'closed'.
UPDATE sessions
SET status = 'closed', updated_at = datetime('now')
WHERE status = 'superseded'
  AND id NOT IN (SELECT to_session FROM session_edges WHERE kind = 'supersedes');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (18, '018_repair_self_supersede');
