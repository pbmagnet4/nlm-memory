# Learner-M0 report: migrations landed

Brief: `.superpowers/sdd/learner-m0-brief.md` (spec §1.7, §2). Date: 2026-10-06.

## Landed

- `migrations/037_learner_evidence.sql` — `learners`, `enrollments`, `learning_events`,
  all STAMP (`tenant_id NOT NULL DEFAULT 'team_local'`, no REFERENCES). No
  `concept_states` table per spec §1.2.
- `migrations/pg/036_learner_evidence.sql` — pg mirror (`TIMESTAMPTZ`, `JSONB`,
  real FKs to `teams(id)`, `BEGIN/COMMIT`).
- Census: 3 STAMP rows appended to `2026-07-22-team-nlm-table-census.md`.
- `tests/integration/pg-migrate.pg.test.ts` — version arrays bumped to include 36.

## Correction to brief

Brief said two version arrays; the file holds **three** (fresh-apply :54, re-run
no-op :93, existing-DB stamp :120). All three bumped — the third test's
`expect(rows…)` block is textually identical to the first, so it was matched with
trailing context. Future migration briefs: grep the count, don't assume two.

## Gates (all observed this session)

- sqlite fresh migrate via repo's own `SqliteStorage.init()` (`/tmp/nlm-m0-sqlite-probe.mjs`,
  throwaway): 3 tables created, `schema_migrations` row `(37, 'learner_evidence')`,
  enrollment columns match spec, second `init()` no-op. Raw-`better-sqlite3` probes
  fail on WAL/vec0 setup — always drive `SqliteStorage`.
- pg: `pg-migrate.pg.test.ts` 3/3 green (`NLM_PG_TEST_URL`, `nlm-pg-test` container;
  Docker Desktop had to be launched — daemon was down on arrival).
- `tests/unit/tenant-census.test.ts` green.

## For M1

Tables exist both lanes. Port + stores can build against them; nothing in M0 blocks M1.
