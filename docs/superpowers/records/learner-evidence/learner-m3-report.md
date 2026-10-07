# Learner-M3 report: MCP tools + wiring + footer landed

Brief: `.superpowers/sdd/learner-m3-brief.md` (spec §1.8, §4). Date: 2026-10-06.

## Landed

- `src/mcp/server.ts`: `McpDeps.learners` group, 4 exported handlers +
  descriptions, 4 zod registrations behind `if (deps.learners)`.
- `src/cli/nlm.ts`: `learners` wired at both assembly sites (HTTP `mcpDeps`,
  stdio `nlm mcp`).
- `src/core/hook/pointer-block.ts`: both footer variants name
  `learner_summary (concept mastery + next step)`. Write tools omitted
  deliberately (recall/supersede precedent: reads advertised, writes
  discovered).
- `tests/unit/core/mcp-learner-tools.test.ts`: 9 handler tests (fake stores).
- Port spillover (brief Step 4 anticipated): `listEnrollments` added to the
  port + both stores + contract (now 19 tests) for no-course disambiguation;
  M2's service-test fake updated for the new method.

## Handler semantics (as briefed, with two pins)

1. Summary format: `LEARNER <id> · <course> (<status>, rev N, M events)` +
   per-concept lines + `Next:` + `Unrecorded sessions (k)` (cap 10, excerpts
   via `truncateSummary`).
2. Unrecorded = sessions bound to the enrollment workstream with
   `startedAt.date > lastEventDate` (strictly greater; same-day sessions are
   conservatively treated as possibly-covered).
3. No-course summary: 0 active → message; >1 → "specify course: a, b";
   exactly 1 → resolves (Gnos `assemble_context` rule).

## Gates (all observed this session)

- `npm run typecheck` clean.
- New handler tests 9/9; M2 unit 42/42; contract 19/19 both lanes;
  pointer-block + strip-injected-context suites green (footer change is
  additive; no exact-match assertions exist on the footer).
- Stdio smoke: `build:server` + `tools/list` over `node dist/cli/nlm.js mcp`
  shows all 4 learner tools.

## For M4

`/api/recall` `relatedConcepts` needs the same deps group on `createApp`
(`src/http/app.ts`) — flagged in the brief, not built. The summary composer
lives in the MCP handler; M4's pointer section should call the service
directly (structured concepts), not parse handler text.
