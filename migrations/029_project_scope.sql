-- migrations/029_project_scope.sql
-- Additive scope column on the five corpus tables (#348 Stage A).
-- No backfill; all existing rows are NULL. Enforcement is deferred behind
-- NLM_SCOPE_ENFORCE. See docs/superpowers/specs/2026-07-03-project-scoping-design.md.

ALTER TABLE sessions ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope);

ALTER TABLE facts ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);

ALTER TABLE code_exemplars ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_code_exemplars_scope ON code_exemplars(scope);

ALTER TABLE signals ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_signals_scope ON signals(scope);

ALTER TABLE workstreams ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_workstreams_scope ON workstreams(scope);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (29, 'project_scope');
