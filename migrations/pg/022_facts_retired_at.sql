-- PG parity for SQLite migration 022: facts.retired_at.
--
-- Mirrors migrations/022_facts_retired_at.sql. Distinct nullable marker for
-- operator retirement of incorrect facts (NLM #326). Recall excludes retired
-- facts; getHistory / includeSuperseded still surface them. Applied manually
-- by an operator.

BEGIN;

ALTER TABLE facts ADD COLUMN IF NOT EXISTS retired_at TEXT;

COMMIT;
