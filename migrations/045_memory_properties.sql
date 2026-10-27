CREATE TABLE memory_properties (
  tenant_id TEXT NOT NULL, slug TEXT NOT NULL, label TEXT NOT NULL,
  aliases TEXT NOT NULL, repositories TEXT NOT NULL,
  PRIMARY KEY (tenant_id, slug)
);
ALTER TABLE facts ADD COLUMN property_slug TEXT;
ALTER TABLE facts ADD COLUMN property_source TEXT;
ALTER TABLE facts ADD COLUMN property_evidence TEXT;
CREATE INDEX idx_facts_property ON facts(tenant_id, property_slug, subject, predicate);
CREATE TABLE property_overrides (
  tenant_id TEXT NOT NULL, source_identity TEXT NOT NULL, assertion_key TEXT NOT NULL,
  property_slug TEXT, PRIMARY KEY (tenant_id, source_identity, assertion_key)
);
CREATE TABLE session_properties (
  tenant_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  property_slug TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY (tenant_id, session_id, property_slug, source)
);
CREATE INDEX idx_session_properties ON session_properties(tenant_id, property_slug, session_id);
