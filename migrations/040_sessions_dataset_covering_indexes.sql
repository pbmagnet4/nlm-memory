-- migrations/040_sessions_dataset_covering_indexes.sql
-- Covering indexes for the whole-corpus reads that run synchronously on the
-- daemon's event loop: the GET /api/dataset session projection and the
-- integrity checks on session status (scheduler sweep and dataset alerts).
--
-- Same class of problem as 037: `status`, `transcript_path`, `runtime` and
-- `tenant_id` sit after `body` (470MB across 21.9k sessions on the reference
-- install), so reading them walks each row's overflow pages. The dataset
-- projection alone read every body; with the integrity checks it took 37 to
-- 125 s and froze the daemon (embeds aborted at their 30 s timeout, hook
-- recall timed out). idx_sessions_status covers only rowid, so the status
-- checks still visited the row to read `id`.
--
-- With these the planner reports COVERING INDEX for both, and the dataset's
-- SQL drops to under 1 s on the same database.

CREATE INDEX IF NOT EXISTS idx_sessions_dataset
  ON sessions(tenant_id, started_at, id, ended_at, duration_min, label, summary, status, transcript_path, runtime);

CREATE INDEX IF NOT EXISTS idx_sessions_status_id
  ON sessions(status, id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (40, 'sessions_dataset_covering_indexes');
