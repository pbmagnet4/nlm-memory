-- Parity: SQLite migrations/019 allows five session_edges.kind values
-- (supersedes, replaces, continues, branched_from, merged_from); pg/019
-- only widened to three. This closes the remaining gap.

BEGIN;

ALTER TABLE session_edges DROP CONSTRAINT IF EXISTS session_edges_kind_check;
ALTER TABLE session_edges ADD CONSTRAINT session_edges_kind_check
  CHECK (kind IN ('supersedes', 'replaces', 'continues', 'branched_from', 'merged_from'));

COMMIT;
