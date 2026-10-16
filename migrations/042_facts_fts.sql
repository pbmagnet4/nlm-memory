CREATE VIRTUAL TABLE facts_fts USING fts5(
  subject, predicate, value, content='facts', content_rowid='rowid',
  tokenize="ascii tokenchars '._-'"
);
CREATE TRIGGER facts_fts_insert AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, subject, predicate, value)
  VALUES (new.rowid, new.subject, new.predicate, new.value);
END;
CREATE TRIGGER facts_fts_delete AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, value)
  VALUES ('delete', old.rowid, old.subject, old.predicate, old.value);
END;
CREATE TRIGGER facts_fts_update AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, value)
  VALUES ('delete', old.rowid, old.subject, old.predicate, old.value);
  INSERT INTO facts_fts(rowid, subject, predicate, value)
  VALUES (new.rowid, new.subject, new.predicate, new.value);
END;
INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');

CREATE INDEX idx_facts_corroboration ON facts (tenant_id, subject, predicate, value, source_session_id);
