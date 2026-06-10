-- PG parity for SQLite migration 020: collapse duplicate active facts (#301).
--
-- One-shot repair, applied manually by an operator against a PG canonical store
-- (PgStorage.init only runs 001_initial.sql; there is no version-gated runner on
-- the PG side). Mirrors migrations/020_collapse_duplicate_active_facts.sql.
--
-- Within each conflicting (subject, predicate) group, the newest active fact
-- (created_at, then id) stays active; the older actives get superseded_by set
-- to that newest fact's id. The PG ingest path already collapsed all priors
-- set-wise, so this only repairs rows the SQLite-era single-prior loop stranded
-- in a corpus migrated to PG.

BEGIN;

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
  ) ranked
  WHERE rn = 1
),
conflicts AS (
  SELECT subject, predicate
  FROM facts
  WHERE superseded_by IS NULL
  GROUP BY subject, predicate
  HAVING COUNT(*) > 1
)
UPDATE facts f
SET superseded_by = w.winner_id
FROM winners w, conflicts c
WHERE f.subject = w.subject
  AND f.predicate = w.predicate
  AND f.subject = c.subject
  AND f.predicate = c.predicate
  AND f.superseded_by IS NULL
  AND f.id != w.winner_id;

COMMIT;
