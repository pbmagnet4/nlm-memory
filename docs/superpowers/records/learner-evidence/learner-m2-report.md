# Learner-M2 report: validation + summary + service landed

Spec checklist: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` §3
(no brief tier — built straight from the spec). Date: 2026-10-06.

## Landed

- `src/core/learner/validate.ts` — Gnos evidence-contract port: slug/concept
  formats, nonempty task/response/nextStep, result/help/kind enums, real
  calendar dates never in the future, positive-int plan revisions. Throws
  `Error`; M3 maps to tool errors.
- `src/core/learner/summary.ts` — deterministic rule port:
  exposed → practicing → demonstrated → retained (retrieval/transfer on a
  strictly later date than an earlier unassisted success); later failure
  demotes; never "mastered". Output sorted by concept.
- `src/core/learner/service.ts` — `enrollCourse` (validate → resolve
  workstream id-or-label → init-if-missing → enroll),
  `recordLearningEvent`, `completeLearnerCourse`, `getCourseSummary`
  (null on missing enrollment; nextStep/lastEventDate from the last event).
- `tests/unit/core/learner/`: `summary.test.ts` (13 conformance cases incl.
  the Gnos chain-rule fixture, same-date non-retention, demotion,
  multi-concept independence), `validate.test.ts` (22 cases), `service.test.ts`
  (7 orchestration cases over an in-memory fake store).

## Decisions (within spec, recorded here)

1. Unrecorded-session listing stays M3: it needs SessionStore, which the
   service deliberately does not take. `CourseSummary` carries `eventCount` /
   `lastEventDate` so M3 can compute the join.
2. `getCourseSummary` returns null on missing enrollment (friendly for the
   M3 tool); record/complete throw via the store (fail-fast on writes).
3. Attempt-on-uncovered-concept is tracked (attempt implies coverage) rather
   than rejected — validation stays shape-level per the spec.

## Gates (all observed this session)

- `npm run typecheck` clean (src + tests + scripts).
- `tests/unit/core/learner`: 42/42 green.
- M1 regression: sqlite contract 18/18, pg contract 18/18.

## For M3

Service surface is stable: 4 ops + `CourseSummary`. M3 adds MCP tools,
`nlm.ts` → `McpDeps` wiring, pointer-block footer names, and the
unrecorded-sessions join.
