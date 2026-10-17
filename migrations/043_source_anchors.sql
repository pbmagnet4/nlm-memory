ALTER TABLE sessions ADD COLUMN body_version TEXT;
ALTER TABLE facts ADD COLUMN source_start INTEGER;
ALTER TABLE facts ADD COLUMN source_end INTEGER;
ALTER TABLE facts ADD COLUMN source_body_version TEXT;
ALTER TABLE facts ADD COLUMN source_quote_status TEXT;

-- Compatible old writers omit body_version from their UPDATE/UPSERT clause.
CREATE TRIGGER sessions_body_version_guard
AFTER UPDATE OF body ON sessions
WHEN NEW.body IS NOT OLD.body AND NEW.body_version IS OLD.body_version
BEGIN
  UPDATE sessions SET body_version = NULL WHERE id = NEW.id;
END;

-- Version-only updates must not recursively update FTS during a body update.
DROP TRIGGER sessions_au;
CREATE TRIGGER sessions_au AFTER UPDATE OF label, summary, body ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, label, summary, body)
  VALUES('delete', old.rowid, old.label, old.summary, old.body);
  INSERT INTO sessions_fts(rowid, label, summary, body)
  VALUES (new.rowid, new.label, new.summary, new.body);
END;
