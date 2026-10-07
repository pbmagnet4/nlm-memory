### Learner-M1: Port + stores + contract tests

Governing spec: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` (§1.1–1.4, §3).
Depends on: Learner-M0 landed (tables exist both lanes).

**Files:**
- Create: `src/ports/learner-store.ts`,
  `src/core/storage/sqlite-learner-store.ts`, `src/core/storage/pg-learner-store.ts`,
  `tests/contract/learner-store.contract.ts`,
  `tests/integration/learner-store.test.ts`, `tests/integration/learner-store.pg.test.ts`
- Touch: none (wiring into `nlm.ts`/`McpDeps` is M3; validation/summary logic is M2 —
  M1 is the port + persistence + contract only)

**Interfaces:** `LearnerStore`, `tenantId`-first on every method (M2 tenancy rule,
cf. `src/ports/fact-store.ts:9-13`, `src/ports/workstream-store.ts:4-9`):

```ts
export interface LearnerInit { id: string; label: string; profile?: Record<string, unknown>; }
export interface EnrollmentInput {
  learnerId: string; courseId: string; workstreamId: string;
  planRef: string; planRevision: number; planFingerprint: string;
}
export interface LearningEventInput {
  id: string; date: string; covered: string[]; attempts: unknown[];
  interpretation: string; nextStep: string;
}
export interface LearnerStore {
  initLearner(tenantId: string, input: LearnerInit): Promise<void>;
  getLearner(tenantId: string, id: string): Promise<Learner | null>;
  enroll(tenantId: string, input: EnrollmentInput): Promise<Enrollment>;
  getEnrollment(tenantId: string, learnerId: string, courseId: string): Promise<Enrollment | null>;
  recordEvent(tenantId: string, learnerId: string, courseId: string, event: LearningEventInput): Promise<"inserted" | "noop">;
  listEvents(tenantId: string, learnerId: string, courseId: string): Promise<ReadonlyArray<LearningEvent>>;
  completeCourse(tenantId: string, learnerId: string, courseId: string): Promise<void>;
}
```

Semantics (spec §3): `recordEvent` on identical id = `"noop"` (safe retry);
conflicting id = throw, never rewrite — check-then-insert in one transaction.
`completeCourse` preserves `completion_history_json`. M1 validates shape only
(nonempty ids); Gnos rule validation (enums, dates, fingerprints) is M2's
`validate.ts` sitting on top of this port.

- [ ] **Step 1: Port** `src/ports/learner-store.ts` — types + interface above,
  tenant-first doc comment matching the fact-store header.
- [ ] **Step 2: sqlite impl** — mirror `sqlite-fact-store.ts` structure
  (prepared statements, tenant clause on every read/write, JSON columns via
  `JSON.stringify`/`parse`). `enroll` upserts on (`learner_id`, `course_id`)
  only when status/fingerprint match, else throws (re-enroll after plan change
  requires explicit revision bump — M2 enforces, M1 throws on any fingerprint mismatch).
- [ ] **Step 3: pg impl** — mirror `pg-fact-store.ts` (parameterized queries,
  same tenant clause). Timestamps `TIMESTAMPTZ`; JSON columns `JSONB`.
- [ ] **Step 4: Contract** `tests/contract/learner-store.contract.ts` —
  init/get round-trip, enroll/get round-trip, record/list ordering (date, then
  insertion), identical-retry noop, conflicting-retry throws, cross-tenant
  isolation (same ids, two tenants, no visibility), complete preserves history.
  Mirror `tests/contract/fact-store.contract.ts` runner shape; wire both
  integration runners (`.test.ts` sqlite, `.pg.test.ts` per-file schema isolation, M7).
- [ ] **Step 5: Gates** — `npm run typecheck`; contract suite green sqlite + pg
  (`test:pg` needs `NLM_PG_TEST_URL`); `tenant-census.test.ts` still green.
  Write report `.superpowers/sdd/learner-m1-report.md` on landing.
