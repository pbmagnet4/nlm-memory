### Learner-M0: Migrations — learner evidence tables (sqlite 037 / pg 036)

Governing spec: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` (§1.7, §2).

**Files:**
- Create: `migrations/037_learner_evidence.sql`, `migrations/pg/036_learner_evidence.sql`
- Edit: `docs/superpowers/specs/2026-07-22-team-nlm-table-census.md` (3 rows),
  `tests/integration/pg-migrate.pg.test.ts` (2 version arrays)

**Interfaces:** Produces tables `learners`, `enrollments`, `learning_events`
(all STAMP). No `concept_states` table — summaries are computed, never stored (spec §1.2).

- [ ] **Step 1: SQLite migration** `migrations/037_learner_evidence.sql`
  (STAMP without REFERENCES, per `034:3-5`):

```sql
-- migrations/037_learner_evidence.sql
-- Learner evidence (spec 2026-10-06 §2). STAMP tables: tenant_id NOT NULL
-- DEFAULT 'team_local', no REFERENCES (see 034 header).
CREATE TABLE IF NOT EXISTS learners (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  tenant_id    TEXT NOT NULL DEFAULT 'team_local',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS enrollments (
  id                      TEXT PRIMARY KEY,
  learner_id              TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
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
  UNIQUE (learner_id, course_id)
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
```

- [ ] **Step 2: pg mirror** `migrations/pg/036_learner_evidence.sql` — same tables,
  `TIMESTAMPTZ` timestamps, `tenant_id` with real FK to `teams(id)`, wrapped in
  `BEGIN;`/`COMMIT;`, one statement per line to mirror sqlite (025-pair convention).
- [ ] **Step 3: Census rows** — append to the census table
  (`| Table | Disposition | Rationale / parent |`):
  `| learners | STAMP | learner-evidence corpus |`,
  `| enrollments | STAMP | learner-evidence corpus |`,
  `| learning_events | STAMP | learner-evidence corpus |`.
  (Enforced by `tests/unit/tenant-census.test.ts`, which requires a `| <table> |` row.)
- [ ] **Step 4: pg version arrays** — append `36` to both arrays in
  `tests/integration/pg-migrate.pg.test.ts` (:54, :93). Both runners discover by
  directory scan (`migrate.ts` readdir, `pg-migrate.ts:49`) — no registry bump exists.
  sqlite has no pinned version array (verified 2026-10-06).
- [ ] **Step 5: Gates** — sqlite migrate clean on fresh + existing DB;
  `test:pg` migrate clean; `tenant-census.test.ts` green. Write report
  `.superpowers/sdd/learner-m0-report.md` on landing.
