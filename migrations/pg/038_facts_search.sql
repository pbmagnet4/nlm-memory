CREATE INDEX idx_facts_lexical ON facts USING gin (to_tsvector('simple', subject || ' ' || predicate || ' ' || value));
