-- migrations/037_learner_evidence.sql
-- Learner evidence (spec 2026-10-06-learner-evidence-design.md §2).
-- STAMP tables: tenant_id NOT NULL DEFAULT 'team_local', no REFERENCES (see 034 header).
-- Summaries are computed from events, never stored: no concept_states table.

CREATE TABLE IF NOT EXISTS learners (
  id           TEXT NOT NULL,
  label        TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  tenant_id    TEXT NOT NULL DEFAULT 'team_local',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id                      TEXT PRIMARY KEY,
  learner_id              TEXT NOT NULL,
  course_id               TEXT NOT NULL,
  workstream_id           TEXT REFERENCES workstreams(id),
  plan_ref                TEXT NOT NULL,
  plan_revision           INTEGER NOT NULL,
  plan_fingerprint        TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
  completion_history_json TEXT NOT NULL DEFAULT '[]',
  tenant_id               TEXT NOT NULL DEFAULT 'team_local',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, learner_id, course_id),
  FOREIGN KEY (tenant_id, learner_id) REFERENCES learners(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS learning_events (
  id              TEXT NOT NULL,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  covered_json    TEXT NOT NULL DEFAULT '[]',
  attempts_json   TEXT NOT NULL DEFAULT '[]',
  interpretation  TEXT NOT NULL DEFAULT '',
  next_step       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL DEFAULT 'team_local',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (enrollment_id, id)
);

CREATE INDEX IF NOT EXISTS idx_learners_tenant    ON learners(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant ON enrollments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_ws     ON enrollments(workstream_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant      ON learning_events(tenant_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (37, 'learner_evidence');
