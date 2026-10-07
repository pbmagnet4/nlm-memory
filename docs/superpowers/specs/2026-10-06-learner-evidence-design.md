# Learner Evidence Design (Gnos-style concept tracking in NLM)

**Status:** GOVERNING SPEC v1 — pinned decisions for the learner-evidence build (M0–M6).
Every load-bearing claim carries a code citation, verified against the tree on 2026-10-06.
**Date:** 2026-10-06
**Method:** SDD-lite. This spec is the governing doc; task briefs exist for M0/M1/M3/M4
(`docs/superpowers/records/learner-evidence/learner-*.md`) with reports on landing. No program-spec tier: single
feature, additive, no cross-cutting enforcement. Precedent: Team NLM program spec
(`.superpowers/sdd/team-nlm-program-spec.md`).
**Source inspiration:** [Gnos](https://github.com/madhvantyagi/Gnos) (MIT) —
`skills/learner-tracking/` (evidence contract, deterministic summary) and
`skills/course-design/scripts/course_contract.py` (plan fingerprint + revision).

---

## 0. What this is, and is not

Learner evidence is a durable, tenant-scoped record of what a learner has **demonstrably**
learned — concept-level attempt evidence plus a next step — recorded explicitly and
recalled at session start across runtimes via the existing hook + MCP surface.

It is **not** pedagogy. No lesson authoring, media generation, course viewer, or teacher
personas enter NLM (Gnos `teachers/*/SOUL.md`, manim/PDF/JSXGraph skills, and
`course-viewer` stay out). It is **not** classifier-extracted in v1: attempts enter only
through an explicit record call, never through ingest classification.

## 1. Pinned decisions

1. **Dedicated store, not a Fact overload.** `FactKind` stays
   `decision | open | attribute` (`src/shared/types.ts:213`). Attempt tuples
   (task/response/result/help/kind) do not fit triples and need derived status,
   not supersedence.
2. **Summaries are computed, never stored** (Gnos evidence rule). There is no
   `concept_states` table; `learner_summary` derives status from events on every call.
3. **Enrollment binds to a workstream id at enroll time** (operator binding).
   id-or-label resolution mirrors `recallWorkstreamHandler`
   (`src/mcp/server.ts:237-257`).
4. **No plan-blob table.** An enrollment stores `plan_ref` + `plan_revision` +
   `plan_fingerprint` only; the plan JSON stays in the calling skill layer. A
   fingerprint/revision mismatch blocks writes until reconciled — never silently
   resolved.
5. **Hook injection extends `formatPointerBlock`** (`src/core/hook/pointer-block.ts:57`)
   with an optional 4th section. `composeWorkstreamRecall` is MCP-only (sole caller
   `src/mcp/server.ts:270`) and stays so.
6. **Cold-start mitigation is read-time.** `learner_summary` lists unrecorded sessions
   (bound to the enrollment's workstream since the last event) via a read-time join.
   No SessionEnd write path: SessionEnd is a fail-open client surface
   (`src/hook/session-end-hook.ts:26`) with no transcript access.
7. **Migrations: sqlite `039`, pg `037`.** Numbering is independent per lane
   (pg latest is `036`; sqlite latest is `038`, with a pre-existing 030/031 gap that
   is not ours to fill). Renumbered from the as-built 037/036 after main's
   covering-index sqlite 037 and sources-muse sqlite 038 / pg 036 landed
   mid-branch — the migrator keys on version number, so duplicates silently skip.
   New tables are STAMP per `034`: sqlite
   `tenant_id TEXT NOT NULL DEFAULT 'team_local'` without REFERENCES (SQLite forbids
   ADD COLUMN + REFERENCES + non-NULL default under enforced FKs,
   `migrations/034_tenancy_teams_and_stamps.sql:3-5`); pg with a real FK to
   `teams(id)`. Isolation rests on store-layer enforcement, never schema constraints.
8. **UI v1 is a Thread strip only.** A standalone page is deferred.

## 2. Schema (M0)

- **`learners`** — `id` slug, `label`, `profile_json` (user-stated
  goals/preferences only), `tenant_id` STAMP, timestamps. PK is
  (`tenant_id`, `id`): learner slugs are human-chosen and collide across
  tenants, mirroring the Team NLM entity re-key.
- **`enrollments`** — `id` (`enr_<uuid>`), `learner_id`, `course_id` slug,
  `workstream_id` → workstreams(id), `plan_ref`/`plan_revision`/`plan_fingerprint`,
  `status` CHECK active/completed, `completion_history_json`, `tenant_id` STAMP,
  timestamps. UNIQUE (`tenant_id`, `learner_id`, `course_id`);
  FK (`tenant_id`, `learner_id`) → learners ON DELETE CASCADE.
- **`learning_events`** — `id` TEXT (slug, unique per enrollment),
  `enrollment_id` → enrollments(id) ON DELETE CASCADE, `date` TEXT ISO (never future),
  `covered_json`, `attempts_json` (concept/task/response/result/help/kind),
  `interpretation` TEXT, `next_step` TEXT NOT NULL, `tenant_id` STAMP, `created_at`.
- Idempotent DDL (`IF NOT EXISTS`; pg in `BEGIN/COMMIT`), mirroring the 025 pair.
  Census rows (`| learners | STAMP | … |` etc.) added to
  `docs/superpowers/specs/2026-07-22-team-nlm-table-census.md` (enforced by
  `tests/unit/tenant-census.test.ts`).

## 3. Store + service (M1/M2)

- Port `src/ports/learner-store.ts`, `tenantId`-first throughout:
  `initLearner`, `getLearner`, `enroll`, `getEnrollment`, `recordEvent`
  (identical id = safe no-op; conflicting id = throw, never rewrite),
  `listEvents`, `completeCourse` (marks completed, preserves history, never
  fabricates mastery).
- Impls `src/core/storage/sqlite-learner-store.ts` + `pg-learner-store.ts`,
  mirroring the fact-store pair and tenant-clause handling.
- Contract `tests/contract/learner-store.contract.ts`, run by
  `tests/integration/learner-store.test.ts` + `.pg.test.ts`.
- Core `src/core/learner/`: `model.ts`, `validate.ts` (ported Gnos rules: slug and
  `subject.concept` ids, result/help/kind enums, nonempty task/response/next_step,
  no-future dates, fingerprint match on write), `summary.ts` (exposed → practicing →
  demonstrated → retained; later failure demotes; never emits "mastered"),
  `service.ts` (enroll/record/complete orchestration).

## 4. MCP surface (M3)

Four tools in `src/mcp/server.ts`, following the zod `registerTool` pattern
(`recall_sessions` at :925): `learner_enroll`, `learner_record`,
`learner_summary` (limit-capped, excerpts truncated to 200 chars via
`truncateSummary`), `learner_complete_course`. Write tools:
`readOnlyHint: false`, `idempotentHint: true`. Wired in `src/cli/nlm.ts` into
`McpDeps` in the same conditional shape as `factRecall`/`factStore` (tools
unregistered when absent). New tool names added to the pointer-block footer, which
is the tool-inventory distribution surface (`pointer-block.ts:4-7`).

## 5. Recall integration (M4, highest risk)

Chain (8 touch points — the M4 brief corrected the original "4": recall flows
through RecallService, not inline in the route): `GET /api/recall`
(`src/http/app.ts:758`) accepts `?withConcepts=true` (hook-source automatic,
facts precedent) → `RecallService` attaches `relatedConcepts` when
`withRelatedConcepts` + wired deps + `NLM_HOOK_INJECT_CONCEPTS` (default true)
→ `pickRelatedConcepts` resolves top-5 hits' workstream bindings →
active enrollments → per-concept summaries, ranked practicing-first, capped
at 5 (`NLM_HOOK_CONCEPT_LIMIT`) → `recall-over-http.ts` maps the field
(old-server tolerant) → `RecallFetchResult.concepts` →
`formatPointerBlock` renders `## Learning state` with deduped Next lines
(cap 2, 120 chars each; worst-case section ≈ 145 tokens). Pointer-only
discipline holds: statuses + next steps, no excerpts. Any failure →
concepts omitted, block still renders (fail-open picker + isolated
enrichment, same rule as `get_session`'s outcome attach).

## 6. UI + eval + rollout (M5/M6)

- M5: Thread-strip chips + next_step in `src/ui/pages/Thread.tsx` per
  `src/ui/components/README.md`; data via the session-detail path.
- M6: summary-rule conformance suite, recall precision-gate entry for
  `learner_summary`, cross-learner/cross-tenant isolation negatives;
  `logs/CHANGELOG/CHANGELOG.md` append (10-entry cap). Re-derivation-spec
  (`2026-08-03-re-derivation-detection-design.md`) integration explicitly deferred.
- Rollout: default-team single-user first; Team NLM inherits tenancy via STAMP.

## 7. Milestones and gates

| Milestone | Scope | Gate |
|---|---|---|
| M0 | Migrations 039/037 + census + pg test bump | migrate clean both lanes; census test green |
| M1 | Port + both stores + contract tests | contract suite green sqlite + pg |
| M2 | Validation + summary + service | typecheck; unit incl. Gnos fixtures |
| M3 | 4 MCP tools + wiring + footer | MCP tests; stdio smoke |
| M4 | Recall chain (4 touch points) | hook tests; deadline test; token budget |
| M5 | Thread strip | `build:ui`; component conventions |
| M6 | Eval + changelog + rollout | precision gate; isolation negatives |

Per-milestone: `typecheck` → unit → integration → `test:pg` (needs
`NLM_PG_TEST_URL`). M5 may parallelize with M4 (disjoint files).

## 8. Open items (deferred, not undecided)

- Re-derivation detector integration (Phase 5 of the proposal; needs its own brief).
- `recall_workstream` output extension with learner state (optional; hook path first).
- Gnos fixture port: MIT-licensed; keep attribution header on ported fixtures.
