# Learner-M5 report: Thread strip (drawer section) landed

Spec checklist: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` §6
(no brief tier — built straight from the spec). Date: 2026-10-06.

## Landed

- `GET /api/learner/by-session/:id` (`src/http/app.ts`): enrollments +
  ranked concepts for the session's workstream, reusing `pickRelatedConcepts`.
  200 with possibly-empty arrays once the session resolves; 404 on unknown
  session or unwired deps. Wired via `HttpDeps.learnerRecall` in `nlm.ts`.
- `SessionDrawer.tsx`: "Learning state" section after Summary — enrollment
  label (`alex/calculus`), one text row per concept
  (`[practicing] math.chain-rule (2 attempts)`), deduped Next lines (cap 2).
  Fail-silent fetch: missing enrollment or failed request hides the section
  instead of breaking the drawer.
- `tests/unit/http/learner-routes.test.ts`: 4 route tests (shape, empty,
  unknown session, unwired).

## Deliberate deviations

1. **Text rows, not chips.** The components README forbids inventing badge
   classes, and concept statuses fit neither `status-*` (lifecycle) nor
   `severity-*` (problems). The strip uses existing `drawer-list` /
   `drawer-paragraph` / `mono` / `muted` classes only, zero new CSS. If a
   chip family for learning states is wanted, that's Edward's call.
2. **Drawer, not the Thread list.** The "Thread strip" lives in the
   session-detail drawer (the session-detail path the spec named), not on
   thread rows — per-session data belongs with the session.
3. **No component tests.** The repo has no component-test harness (only a
   `thread-groups` lib test under `tests/unit/ui`), and adding jsdom +
   testing-library for one section would violate the no-new-framework rule.
   Coverage is the route contract test; the drawer section is a thin render
   of that contract.

## Gates (all observed this session)

- `npm run typecheck` clean; `npm run build:ui` clean (169ms).
- Route tests 4/4; regression 223/223 across http/hook/learner suites.

## For M6

Feature work is complete (M0–M5). M6: eval entry, CHANGELOG append, rollout
notes. UI bundle deploy (`scp dist/ui/…`) stays manual per CLAUDE.md.
