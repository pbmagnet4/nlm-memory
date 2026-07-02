-- PG parity for SQLite migration 019: split the mechanical `replaces` relation
-- out of `supersedes`.
--
-- Idempotent: safe to re-apply on a database that already has this shape.
-- DROP CONSTRAINT IF EXISTS removes any existing named constraint before the
-- DO-block re-adds it, so duplicate_object is never raised in practice;
-- the EXCEPTION clause is defensive for parity with the 001 pattern.
--
-- Widens the CHECK constraints on sessions.status and session_edges.kind to
-- admit 'replaced' / 'replaces', then reclassifies existing mechanical edges:
-- an edge whose two sessions share the same transcript_path is a re-parse
-- (replaces); different paths is operator supersedence (untouched).

BEGIN;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
DO $$
BEGIN
  ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('active', 'closed', 'superseded', 'replaced'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE session_edges DROP CONSTRAINT IF EXISTS session_edges_kind_check;
DO $$
BEGIN
  ALTER TABLE session_edges ADD CONSTRAINT session_edges_kind_check
    CHECK (kind IN ('supersedes', 'replaces', 'continues'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE session_edges e SET kind = 'replaces'
WHERE e.kind = 'supersedes'
  AND (SELECT transcript_path FROM sessions WHERE id = e.from_session)
    = (SELECT transcript_path FROM sessions WHERE id = e.to_session);

UPDATE sessions SET status = 'replaced', updated_at = NOW()
WHERE status = 'superseded'
  AND id IN (SELECT to_session FROM session_edges WHERE kind = 'replaces');

COMMIT;
