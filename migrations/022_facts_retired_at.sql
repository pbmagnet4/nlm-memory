-- Migration 022: facts.retired_at — operator retirement of incorrect facts.
--
-- Before this, `supersede_fact` / `mark_superseded` (MCP) called
-- markSuperseded(id, null), which set superseded_by = NULL — a no-op, since
-- active facts already have superseded_by IS NULL. Retired facts kept serving
-- in recall (NLM #326). Retirement-without-a-successor was structurally
-- impossible because supersededness is encoded ONLY by a non-null successor
-- id (and invariant I5b requires that id to reference a real fact).
--
-- retired_at is a distinct nullable marker: a non-null timestamp means an
-- operator declared the fact wrong/noise. Recall excludes retired facts the
-- same way it excludes superseded ones; getHistory and includeSuperseded
-- still surface them so the audit trail survives.

ALTER TABLE facts ADD COLUMN retired_at TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (22, '022_facts_retired_at');
