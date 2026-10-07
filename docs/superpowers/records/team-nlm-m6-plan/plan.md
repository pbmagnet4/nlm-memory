# Team NLM M6 — state-file tenancy (plan)

Board: Whtnxt Agent NocoDB #409. Spec: `.superpowers/sdd/team-nlm-program-spec.md` §7 + leak-contract case 12 (§6). Flips the last non-concurrency leak-contract case and un-gates the M6-FILTER hosted routes.

## Design decision (recorded)

**Per-tenant subdirs, not DB rows.** Spec §7 allows either. Chosen because: single-replica beta (decision 5) makes files sufficient; DB rows would rewrite the digest/precision/reranker/stats readers for no beta-visible gain; and the subdir route preserves the byte-identical-local-UX carve-out used by M3/M4. Revisit at replicas > 1 (already a standing spec note for the other process-local state).

**Path contract:** `tenantId === DEFAULT_TEAM_ID` → legacy path unchanged (`~/.nlm/query_log.jsonl`, `~/.nlm/hook-state/`, etc.). Any other tenant → `~/.nlm/tenants/<sanitized-tenantId>/<same basename>` (memo dir: `~/.nlm/tenants/<t>/hook-state/`). Sanitize tenantId `[^A-Za-z0-9_-] → _` (same rule memo.ts already uses for conversation ids). Env-var overrides (`NLM_QUERY_LOG` etc.) keep pointing at the DEFAULT_TEAM_ID location only; non-default tenants always use the derived path (an env override that redirected all tenants to one file would recreate the leak).

## Global constraints

- `tenantId: string` is **non-optional and first parameter** on every exported read/write function of the file-state modules — same convention as the M2 store threading. `DEFAULT_TEAM_ID` supplied only at composition roots (HTTP route handler entry, MCP tool entry, CLI command action, client-side hook mains). Never defaulted mid-chain.
- Local mode byte-identical: with only DEFAULT_TEAM_ID traffic, every path, file format, and behavior is unchanged. Existing tests must pass without fixture moves.
- Telemetry paths never raise (preserve each module's existing swallow-errors contract).
- No new dependencies. TDD per task; suite + `tsc --noEmit` green per task.

## Task 1 — tenant-aware paths in the file-state modules

Add `src/core/tenancy/tenant-state-path.ts`: `tenantStatePath(tenantId: string, ...segments: string[]): string` implementing the path contract above (exported constant for the `tenants` dirname; mkdir is the caller's existing job). Thread non-optional `tenantId` (first param) through every exported function of:

- `src/core/hook/memo.ts` (`loadSurfaced`, `recordSurfaced`, prune/cleanup helpers — the state DIR becomes tenant-derived; `NLM_HOOK_STATE_DIR` override = default-team location only)
- `src/core/hook/hook-log.ts` (`appendHookLog`, readers if any)
- `src/core/recall/query-log.ts` (`logQuery`, stats/readers)
- `src/core/recall/citation-log.ts` (append + readers)
- `src/core/recall/miss-log.ts` (append + readers)
- `src/core/recall/hook-recall-log.ts` (reader)
- `src/core/recall-facts/fact-query-log.ts` (`logFactQuery`, stats)

Update the modules' own unit tests: thread `DEFAULT_TEAM_ID` at existing call sites; add per-module cases asserting (a) default team hits the legacy path, (b) a second tenant hits `tenants/<t>/…`, (c) two tenants' writes don't collide. Do NOT update non-test callers yet (compile will be red at workspace level only if these modules' callers are in the same tsc project — if so, thread mechanically with `DEFAULT_TEAM_ID` placeholders and Task 2 replaces them with real tenant resolution; note which files got placeholders in the report).

## Task 2 — thread real tenant identity through callers + un-gate M6-FILTER

- `src/http/app.ts`: every M6-FILTER route handler passes `c.get("tenantId")` into the log/memo calls; **remove the five M6-FILTER entries from `HOSTED_GATED_ROUTES`** (`/api/recall/cite-event`, `/api/citation/explicit`, `/api/recall/stats`, `/api/recall/recent`, `/api/recall/facts/stats`, `/api/hook/pre-compact`, `/api/hook/hermes-agent/post-turn`, `/api/hook/hermes-agent/session-lifecycle` — all 8 M6-FILTER rows) and delete the now-empty disposition comments referencing M6-FILTER-pending state. LOCAL rows stay.
- `src/mcp/server.ts`: cite_session + any log-touching tools pass the request-resolved tenant.
- `src/cli/digest.ts`, `src/cli/nlm.ts`, `src/hook/*.ts` (prompt-recall, stop, pre-compact, session-start), `src/core/hook/citation-detect.ts`, `src/core/digest/*` readers, `src/core/recall/precision.ts`, `src/core/recall/reranker.ts`, `src/core/storage/sqlite-outcome-store.ts`: thread `DEFAULT_TEAM_ID` from each composition root (these are local-mode surfaces).
- Replace any Task-1 placeholders with the real value from the composition root.
- Update the hosted-gate tests that assert 403 on M6-FILTER paths: those routes now serve tenant-scoped responses in hosted mode (assert 200/valid shape with a resolvable token, and that the LOCAL rows still 403).

## Task 3 — flip leak-contract case 12 + pg twin

In `tests/integration/tenant-leak-contract.test.ts` replace the case-12 `it.todo` with real assertions (keep the exact case text as the test name):

- Memo: `recordSurfaced(A, convId, [sessionA])` then `loadSurfaced(B, convId)` is empty — a conversation-id collision across teams shares no dedup state.
- Query/citation/miss/hook logs: write one entry as A and one as B (distinct ids); each tenant's stats/reader output contains only its own entry; the legacy default-team file receives neither non-default tenant's rows.
- HTTP-level: `/api/recall/stats` as token-A reflects A's write only (reuses the case-8 token fixtures).

Add the pg-twin case in `tenant-leak-contract.pg.test.ts` where the fixture supports it (file-state is backend-independent — if the pg twin adds nothing beyond the sqlite case, say so in the report and add a one-line comment in the pg file instead of a duplicate test).

Update the contract header comment (cases 1-9, 11-12 live; 10 still M7-harness-gated… it already landed — verify and state the true remaining set).

## Acceptance (spec M6 row)

No cross-tenant collision in memo state; recall-precision/miss metrics computable per tenant; no metric aggregates across tenants; case 12 green both lanes; M6-FILTER routes tenant-filtered in hosted mode; local mode byte-identical.

## Task 4 — supersedence-log tenancy (added after Task 2 review; executes BEFORE Task 3)

`src/core/storage/supersedence-log.ts` writes a single shared `~/.nlm/supersedence-log.jsonl` with no tenant anywhere in its API, and is reachable in hosted mode via `POST /api/session/:id/supersede` (src/http/app.ts:1689) and the `mark_superseded` / `supersede_fact` MCP tools (src/mcp/server.ts:703, :760). Apply the exact Task-1 path contract to this module: non-optional `tenantId` first param on every exported read/write function (incl. `appendFactSupersedence` and `readSupersedenceLog`); default team → legacy path incl. `NLM_SUPERSEDENCE_LOG` override; other tenants → `~/.nlm/tenants/<sanitized>/supersedence-log.jsonl`. Thread the request-resolved tenant at the three call sites (+ any others grep finds); the read-side enrichment fencing in getSessionHandler keeps working (it reads the caller's tenant file now). Module unit tests: same (a)/(b)/(c) trio as Task 1. Update the hosted-gate/route tests only if any asserted this route's behavior.

## Task 3 amendment

Case 12 additionally asserts: `appendSupersedence` as A then `readSupersedenceLog` as B returns nothing for B (and the HTTP supersede route as token-A is invisible to token-B's `get_session` enrichment where cheap to assert at the store level).
