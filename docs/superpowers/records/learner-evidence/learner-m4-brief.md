### Learner-M4: recall-chain integration (highest risk)

Governing spec: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` §5.
Depends on: Learner-M3 landed. Corrects the spec's "4 touch points" — the real
chain runs through RecallService, so it is 8 steps below (spec §5 amended in
the M4 report, not here).

**Files:**
- Edit: `src/shared/types.ts` (query/result fields + `RelatedConcept`),
  `src/core/recall/recall-service.ts` (deps + attach block),
  `src/http/app.ts` (`?withConcepts`, hook-auto),
  `src/cli/nlm.ts` (buildStack RecallService deps),
  `src/hook/recall-over-http.ts` (mapping), `src/hook/prompt-recall-hook.ts`
  (`RecallFetchResult.concepts` + pass-through),
  `src/core/hook/pointer-block.ts` (`PointerConcept` + 4th section),
  `src/ports/learner-store.ts` + both stores (enrollments-by-workstream),
  `tests/contract/learner-store.contract.ts` (1 test)
- Create: `src/core/recall/related-concepts.ts`,
  `tests/unit/core/recall/related-concepts.test.ts`
- Extend: `tests/unit/core/hook/pointer-block.test.ts` (concepts section),
  `tests/unit/hook/recall-over-http.test.ts` (mapping),
  `tests/integration/prompt-recall-hook.test.ts` (pass-through)

**Interfaces:**

```ts
// types.ts
interface RelatedConcept {
  readonly concept: string;
  readonly status: "exposed" | "practicing" | "demonstrated" | "retained";
  readonly attemptCount: number;
  /** Owning enrollment's latest next_step (shared across its concepts). */
  readonly nextStep: string | null;
}
// RecallQuery += withRelatedConcepts?: boolean
// RecallResult += relatedConcepts?: ReadonlyArray<RelatedConcept>

// recall-service.ts
RecallServiceDeps += readonly learnerDeps?: {
  readonly learners: LearnerStore;
  readonly sessions: Pick<SessionStore, "getWorkstreamIds">;
};

// learner-store.ts
listEnrollmentsByWorkstreams(tenantId, workstreamIds): Promise<ReadonlyArray<Enrollment>>;
```

- [ ] **Step 0: enrollments-by-workstream read** — port + both stores
  (`WHERE workstream_id = ANY($n)` pg / `IN (...)` sqlite via tenantClause;
  empty input → [] immediately, no query) + 1 contract test (two
  enrollments on different workstreams resolve independently; unknown id → []).
- [ ] **Step 1: `pickRelatedConcepts`** (`src/core/recall/related-concepts.ts`),
  mirroring `related-facts.ts` structure + fail-open (any throw → []):
  top-5 hits → `getWorkstreamIds` → dedupe non-null → active enrollments →
  per enrollment `listEvents` → `summarizeConcepts` → rows
  `{concept, status, attemptCount, nextStep}` → sort by status rank
  (practicing 0, exposed 1, demonstrated 2, retained 3), then concept → cap
  (`NLM_HOOK_CONCEPT_LIMIT`, default 5, `readInt` pattern).
- [ ] **Step 2: RecallService attach** — `withRelatedConcepts === true &&
  this.deps.learnerDeps && isConceptInjectionEnabled()` (new
  `NLM_HOOK_INJECT_CONCEPTS`, default true — empty when no enrollments, so
  zero behavior change for non-learner users), placed after the facts block
  (`recall-service.ts:266-269`). Gated by its own flag, not the facts flag.
- [ ] **Step 3: HTTP + composition** — `/api/recall` `?withConcepts=true`,
  hook-source automatic (facts precedent: explicit param wins, else
  `source === "hook"` → true). `buildStack` (`nlm.ts:378`) wires
  `learnerDeps: { learners: storage.learners, sessions: store }`.
- [ ] **Step 4: Client chain** — `recall-over-http.ts` maps `relatedConcepts`
  (absent → `[]`, old-server tolerant); `RecallFetchResult` gains optional
  `concepts: ReadonlyArray<PointerConcept>`; `runHook` passes
  `fetched.concepts ?? []` as the 4th `formatPointerBlock` arg.
- [ ] **Step 5: Pointer section** — `PointerConcept { concept, status,
  attemptCount }` + optional nextSteps param? NO — keep the formatter pure
  like facts: `formatPointerBlock(hits, facts, exemplars, concepts = [])`
  where concepts carry nextStep, rendered as:
  `## Learning state (nlm-memory)` / `- [practicing] math.chain-rule (2 attempts)` /
  deduped `Next: …` lines (cap 2, `truncateSummary`). Empty → no section.
  Pointer-only discipline: statuses + next steps, no excerpts.
- [ ] **Step 6: Tests** — related-concepts unit (empty hits, no workstream,
  ranked/capped output, fail-open on throw, multi-enrollment rows);
  pointer-block section (present/absent/empty/nextStep-dedupe);
  recall-over-http mapping (present/absent field); prompt-recall-hook
  pass-through (fetched concepts reach the block); contract +1 both lanes.
- [ ] **Step 7: Gates** — `typecheck`; new + extended tests; M1–M3 regression
  (both contract runners, `tests/unit/core/learner`, handler tests, hook
  suite); token-budget eyeball (5 concepts + 2 next-steps ≈ 150 tokens max).
  Amend spec §5 touch-point count in the M4 report.
  Write report `.superpowers/sdd/learner-m4-report.md`.
