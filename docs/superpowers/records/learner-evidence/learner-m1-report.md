# Learner-M1 report: port + stores + contract landed

Brief: `.superpowers/sdd/learner-m1-brief.md` (spec §1.1–1.4, §3). Date: 2026-10-06.

## Landed

- `src/core/learner/model.ts` — domain types + `makeEnrollmentId` + `canonicalJson` /
  `learningEventContentEqual` (see fixes below). Slightly ahead of the brief's
  "touch none": the port needs a type home, and the workstream precedent puts
  domain types in core. M2 adds validate/summary/service alongside.
- `src/ports/learner-store.ts` — port as briefed.
- `src/core/storage/sqlite-learner-store.ts` + `pg-learner-store.ts` — impls as
  briefed (shared-connection / pool, `tenantClause`/`tenantClausePg` on every
  WHERE, transactions on check-then-insert paths).
- Wiring (required deviation — see below): `learners` member on the `Storage`
  port + both storage classes. Only two `Storage` implementers exist; typecheck
  confirms nothing else broke.
- `tests/contract/learner-store.contract.ts` (18 tests) +
  `tests/integration/learner-store.test.ts` + `.pg.test.ts` runners.

## Deviations from brief (all in spec, which stays governing)

1. **Storage-aggregate wiring is M1, not M3.** The contract harness runs against
   the `Storage` aggregate (fact-store precedent), so `storage.learners` must
   exist for the contract to run. M3 keeps the `nlm.ts` → `McpDeps` wiring.
2. **Composite learner PK.** `learners.id` as a global PK breaks cross-tenant
   same-slug learners. M0 migrations (uncommitted, applied only to throwaway
   DBs) were edited in place: `learners` PK is now (`tenant_id`, `id`),
   enrollments UNIQUE is (`tenant_id`, `learner_id`, `course_id`) with a
   composite FK. Spec §2 updated to match.
3. **Harness gains `ensureTeam`.** pg FKs require a `teams` row for the second
   tenant; sqlite treats it as a harmless insert. Keeps the contract
   backend-agnostic.

## pg-lane failures found and fixed (contract earned its keep)

4. **JSONB key reordering.** pg JSONB sorts object keys on write, so byte
   comparison of round-tripped attempts false-conflicted on identical retry.
   Fix: `canonicalJson` (recursive key sort) shared in `model.ts`, used by
   both stores.
5. **Timestamp-resolution ordering split.** sqlite stamps seconds, pg
   microseconds, so `ORDER BY date, created_at` ordered same-date events
   differently per backend. Fix: order is now (date, id) on both, documented
   in the port. Date-prefixed event ids preserve insertion order in practice.

## Gates (all observed this session)

- `npm run typecheck` clean (src + tests + scripts).
- sqlite contract 18/18; pg contract 18/18 (`nlm-pg-test` lane).
- `tenant-guard.test.ts` green (no literal `tenant_id =` in new store files);
  `tenant-census.test.ts` green.

## For M2

Port + persistence are done. M2 builds `validate.ts` / `summary.ts` /
`service.ts` on this port; no store changes expected.
