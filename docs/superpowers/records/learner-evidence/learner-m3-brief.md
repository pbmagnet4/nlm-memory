### Learner-M3: MCP tools + wiring + footer

Governing spec: `docs/superpowers/specs/2026-10-06-learner-evidence-design.md` (§1.8, §4).
Depends on: Learner-M2 landed (service surface stable).

**Files:**
- Edit: `src/mcp/server.ts` (McpDeps group + 4 handlers + 4 registrations + descriptions),
  `src/cli/nlm.ts` (2 McpDeps assembly sites: HTTP `mcpDeps` ~:517, stdio `nlm mcp` ~:1531),
  `src/core/hook/pointer-block.ts` (tool footer — both variants)
- Create: `tests/unit/core/mcp-learner-tools.test.ts`

**Interfaces:** new optional McpDeps group (absent = tools unregistered,
fact-tools precedent):

```ts
readonly learners?: {
  readonly store: import("@ports/learner-store.js").LearnerStore;
  readonly workstreams: Pick<import("@ports/workstream-store.js").WorkstreamStore, "getById" | "findByNormalizedLabel">;
  readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams" | "getByIds">;
};
```

Handlers `(deps, tenantId, args)` → `ToolResult`, thin adapters over
`src/core/learner/service.ts` (report_outcome precedent); service `Error`s
surface as tool errors via the existing `err()` path (no new error plumbing).

- [ ] **Step 1: McpDeps group** — add `learners?` to `McpDeps` (`server.ts:65`).
- [ ] **Step 2: Handlers** — `learnerEnrollHandler`, `learnerRecordHandler`,
  `learnerSummaryHandler`, `learnerCompleteHandler`. Enroll/record/complete
  return `okText` one-line confirmations. Summary returns `okText` composed as:
  `LEARNER <id> · <course> (<status>, rev N, M events)` + one line per concept
  (`- [demonstrated] math.chain-rule (3 attempts)`) + `Next: …` + unrecorded
  sessions (`Unrecorded: <id> · <label> (<date>)`, max 10). Excerpts truncated
  to 200 chars via `truncateSummary`.
- [ ] **Step 3: Unrecorded join (read-time, spec §1.6)** — inside the summary
  handler only: `listSessionIdsByWorkstreams(enrollment.workstreamId)` →
  `getByIds` → keep `startedAt > lastEventDate` (ISO prefix compare; all
  sessions when no events yet) → sort ascending → cap 10 → map
  `{id, label, startedAt}`. No SessionStore in the service (M2 decision stands).
- [ ] **Step 4: Registrations** — zod schemas, snake_case params
  (report_outcome precedent):
  - `learner_enroll`: learner, label?, course, workstream (id-or-label),
    plan_ref, plan_revision (int ≥1), plan_fingerprint
  - `learner_record`: learner, course, event { id, date, covered[],
    attempts[] {concept, task, response, result|help|kind enums},
    interpretation, next_step }
  - `learner_summary`: learner, course?, limit? (concepts cap, default 50, max 200)
  - `learner_complete_course`: learner, course
  - Annotations: writes `readOnlyHint:false, idempotentHint:true`;
    summary `readOnlyHint:true`. Descriptions as `LEARNER_*_DESCRIPTION` consts.
  - `learner_summary` with no course: when exactly one active enrollment
    exists use it, else ask (Gnos `assemble_context` rule). Needs a
    `listEnrollments(tenantId, learnerId)` read — add to the port + both
    stores + contract if missing (it is: M1 has get-by-course only).
- [ ] **Step 5: Wiring** — both `nlm.ts` sites get
  `learners: { store: storage.learners, workstreams: storage.workstreams, sessions: store }`.
  (Pick<> shapes accept the full stores.)
- [ ] **Step 6: Footer** — append `learner_summary (concept mastery + next step)`
  to both pointer-block footer variants; the footer is the tool-inventory
  distribution surface (`pointer-block.ts:4-7`). Only the read tool is named
  (write tools are discovered via summary output, same as recall/supersede split).
- [ ] **Step 7: Tests** `tests/unit/core/mcp-learner-tools.test.ts` — handler
  tests with a fake LearnerStore (mcp-report-outcome pattern): enroll ok +
  unknown-workstream error, record ok + invalid-event error without store
  write, summary text shape + unrecorded join (fake sessions), complete ok,
  summary-no-course disambiguation (0/1/2 enrollments).
- [ ] **Step 8: Gates** — `typecheck`; new unit tests; M1/M2 regression
  (both contract runners + `tests/unit/core/learner`); stdio smoke:
  `npm run build:server` then list_tools over `node dist/cli/nlm.js mcp`
  shows the 4 tools. Write report `.superpowers/sdd/learner-m3-report.md`.
  NOTE for M4: `/api/recall` relatedConcepts will need the same deps group on
  `createApp` — flag, don't build.
