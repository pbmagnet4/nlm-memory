-- Migration 024: backfill code_exemplars.repo to logical basenames.
--
-- The pre-#330 session-capture path (captureExemplarsFromSession) stamped the
-- absolute projectDir into the repo column, leaking a host filesystem path
-- (/Users/.../<name>) into the local store — meaningless on a client install
-- and a privacy concern (per-install scoping, synthesis item 4). The #330
-- producer (nlm code-signal) and the now-fixed session-capture path both
-- record the logical basename instead.
--
-- This strips any directory prefix from existing absolute-path repos in place,
-- generically (no hardcoded host path), via a recursive CTE that peels off
-- each segment up to and including the next '/' until none remains. Idempotent:
-- once every repo is a basename, `repo LIKE '/%'` matches nothing and re-running
-- is a no-op. Fresh installs have no leaked rows, so this is a no-op there too.
--
-- The primary key id (sha256 of install_scope|repo|code_hash|outcome) is NOT
-- recomputed — SQLite cannot sha256 in pure SQL. The stale id is harmless: it
-- stays a valid unique key and keeps its embedding link. The only consequence
-- is that re-capturing the exact same legacy commit via the basename path would
-- compute a fresh id and insert a duplicate rather than dedup-skip — a rare
-- edge (requires a full re-ingest of old sessions) and never wrong data.

WITH RECURSIVE basename(id, rest) AS (
  SELECT id, repo FROM code_exemplars WHERE repo LIKE '/%'
  UNION ALL
  SELECT id, substr(rest, instr(rest, '/') + 1) FROM basename WHERE instr(rest, '/') > 0
)
UPDATE code_exemplars
SET repo = (SELECT rest FROM basename WHERE basename.id = code_exemplars.id AND instr(basename.rest, '/') = 0)
WHERE repo LIKE '/%';

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (24, '024_backfill_exemplar_repo_basename');
