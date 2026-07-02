-- Which classifier produced this session's classification. NULL = classified
-- before provenance tracking; nlm reprocess treats NULL as eligible.
ALTER TABLE sessions ADD COLUMN classifier_provider TEXT;
ALTER TABLE sessions ADD COLUMN classifier_model TEXT;
ALTER TABLE sessions ADD COLUMN classifier_confidence REAL;
