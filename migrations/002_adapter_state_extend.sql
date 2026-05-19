-- Migration 002: extend adapter_state with columns needed for supersede-on-resume.
--
-- file_size — bytes-on-disk at last classification (detects file growth)
-- session_id — NLE session id produced by the last classification (target for supersede)
--
-- last_offset stays for future chunking use (Phase 3+). For supersede-on-resume in
-- Phase 2, file_size carries the equivalent signal at whole-file granularity.

ALTER TABLE adapter_state ADD COLUMN file_size INTEGER;
ALTER TABLE adapter_state ADD COLUMN session_id TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (2, '002_adapter_state_extend');
