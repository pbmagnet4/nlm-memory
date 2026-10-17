ALTER TABLE sessions ADD COLUMN body_version TEXT;
ALTER TABLE facts ADD COLUMN source_start INTEGER;
ALTER TABLE facts ADD COLUMN source_end INTEGER;
ALTER TABLE facts ADD COLUMN source_body_version TEXT;
ALTER TABLE facts ADD COLUMN source_quote_status TEXT;

CREATE FUNCTION invalidate_unchanged_body_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.body_version IS NOT DISTINCT FROM OLD.body_version THEN
    NEW.body_version := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_body_version_guard BEFORE UPDATE OF body ON sessions
FOR EACH ROW EXECUTE FUNCTION invalidate_unchanged_body_version();
