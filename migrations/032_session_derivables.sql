-- migrations/032_session_derivables.sql
-- #352 Phase 2: derivable metadata. All nullable: NULL means not-derivable
-- for that runtime, never faked.
ALTER TABLE sessions ADD COLUMN agent_persona TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN primary_model TEXT;
ALTER TABLE sessions ADD COLUMN total_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN skill TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (32, 'session_derivables');
