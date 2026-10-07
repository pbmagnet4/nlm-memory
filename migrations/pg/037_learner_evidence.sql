-- migrations/pg/036_learner_evidence.sql
-- PG parity for SQLite migration 037 (learner evidence). Auto-applied by the
-- version-gated runner (runMigrationsPg). Idempotent: every DDL statement uses
-- IF NOT EXISTS, so re-applying on an existing schema is a no-op.
-- Spec: docs/superpowers/specs/2026-10-06-learner-evidence-design.md §2.
-- Summaries are computed from events, never stored: no concept_states table.

BEGIN;

CREATE TABLE IF NOT EXISTS learners (
  id           TEXT NOT NULL,
  label        TEXT NOT NULL,
  profile_json JSONB NOT NULL DEFAULT '{}',
  tenant_id    TEXT NOT NULL REFERENCES teams(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  completion_history_json JSONB NOT NULL DEFAULT '[]',
  tenant_id               TEXT NOT NULL REFERENCES teams(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, learner_id, course_id),
  FOREIGN KEY (tenant_id, learner_id) REFERENCES learners(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS learning_events (
  id              TEXT NOT NULL,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  covered_json    JSONB NOT NULL DEFAULT '[]',
  attempts_json   JSONB NOT NULL DEFAULT '[]',
  interpretation  TEXT NOT NULL DEFAULT '',
  next_step       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL REFERENCES teams(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (enrollment_id, id)
);

CREATE INDEX IF NOT EXISTS idx_learners_tenant    ON learners(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant ON enrollments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_ws     ON enrollments(workstream_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant      ON learning_events(tenant_id);

COMMIT;
