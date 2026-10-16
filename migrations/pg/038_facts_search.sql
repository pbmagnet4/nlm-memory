CREATE INDEX idx_facts_lexical ON facts USING gin (to_tsvector('simple', subject || ' ' || predicate || ' ' || value));

CREATE INDEX idx_facts_corroboration ON facts (tenant_id, subject, predicate, value, source_session_id);
