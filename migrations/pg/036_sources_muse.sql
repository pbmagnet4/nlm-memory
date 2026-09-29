-- Mirrors migrations/038_sources_muse.sql. Pg alters the CHECK in place.

BEGIN;

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check
  CHECK (kind IN (
    'claude-code', 'codex', 'hermes', 'hermes-agent', 'muse', 'aider',
    'cursor', 'windsurf', 'opencode', 'pi', 'jsonl-generic', 'webhook'
  ));

COMMIT;
