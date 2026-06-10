-- Migration 020: collapse duplicate active facts (NLM #301).
--
-- The SQLite supersedence loop superseded only the single most-recent active
-- prior per new fact (ORDER BY created_at DESC LIMIT 1). Once two facts for the
-- same (subject, predicate) were simultaneously active — a multi-pass backfill,
-- or an ON DELETE SET NULL un-supersede when a re-ingest deleted a chain head —
-- every later ingest cleared only one, so the duplicate persisted. The code fix
-- collapses ALL priors set-wise; this migration repairs the rows already stuck.
--
-- Within each conflicting (subject, predicate) group, the newest active fact
-- (created_at, then id as a deterministic tiebreak) stays active; the older
-- actives get superseded_by = that newest fact's id. Plain UPDATE — no table
-- rebuild, so the runner's BEGIN/COMMIT wrapper is fine (no -- nlm:no-wrap).

WITH winners AS (
  SELECT subject, predicate, id AS winner_id
  FROM (
    SELECT
      subject, predicate, id,
      ROW_NUMBER() OVER (
        PARTITION BY subject, predicate
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM facts
    WHERE superseded_by IS NULL
  )
  WHERE rn = 1
)
UPDATE facts
SET superseded_by = (
  SELECT w.winner_id FROM winners w
  WHERE w.subject = facts.subject AND w.predicate = facts.predicate
)
WHERE superseded_by IS NULL
  AND id != (
    SELECT w.winner_id FROM winners w
    WHERE w.subject = facts.subject AND w.predicate = facts.predicate
  )
  AND EXISTS (
    SELECT 1 FROM facts dup
    WHERE dup.subject = facts.subject AND dup.predicate = facts.predicate
      AND dup.superseded_by IS NULL AND dup.id != facts.id
  );

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (20, '020_collapse_duplicate_active_facts');
