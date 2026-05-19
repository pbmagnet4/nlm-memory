-- Migration 001: rename entity types and action kind
--
-- Renames entity.type values: property→project, person→contact, external→service
-- (The CHECK constraint on entities.type was already dropped in the initial schema.)
-- Safe to re-run: CASE expression only matches old values; INSERT OR IGNORE is a no-op
-- if this migration has already been applied.

UPDATE entities
SET type = CASE
  WHEN type = 'property' THEN 'project'
  WHEN type = 'person'   THEN 'contact'
  WHEN type = 'external' THEN 'service'
  ELSE type
END
WHERE type IN ('property', 'person', 'external');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, 'entity_type_rename');
