-- Which classifier produced this session's classification. NULL = classified
-- before provenance tracking; nlm reprocess treats NULL as eligible.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS classifier_provider TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS classifier_model TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS classifier_confidence REAL;
