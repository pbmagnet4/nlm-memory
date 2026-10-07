# Team NLM M6 — Task 2 report: thread real tenant identity through callers + un-gate M6-FILTER

Status: DONE

Commits (main, no PR — repo convention), from `702786f` (Task 1 HEAD):

- `9baedbf` feat(tenancy): thread tenantId through cite-memo.ts and recent-log.ts
- `6689399` feat(tenancy): thread real tenant identity through mcp/server.ts
- `f2128b5` feat(tenancy): thread tenant identity through http/app.ts, un-gate M6-FILTER routes
- `0cb998e` docs(tenancy): clarify DEFAULT_TEAM_ID is real identity, not a Task-1 placeholder

## Scope note: two modules beyond the brief's literal list

Two file-state modules read/write the same shared state as the 7 Task-1 module list but weren't named in either task's brief, because their callers went untouched by Task 1's mechanical `tsc`-red threading pass:

- **`src/core/hook/cite-memo.ts`** (Stop-hook citation dedup memo — same `~/.nlm/hook-state/` directory as `memo.ts`, filename suffix `.cited.json`). `POST /api/hook/hermes-agent/session-lifecycle` (an M6-FILTER route this task un-gates) calls `clearCited`.
- **`src/core/recall/recent-log.ts`** (the `/live` panel's tail-reader over `query_log.jsonl`, deliberately left out of Task 1's module list per its own report). `GET /api/recall/recent` (also M6-FILTER, also un-gated here) calls `recentQueryLog`.

Un-gating those two routes without threading tenantId through these modules would have shipped exactly the defect M6 exists to close: the routes would either read/clear the shared, non-tenant-scoped legacy file (a real cross-tenant collision on `clearCited`) or silently return nothing for every non-default tenant (`recentQueryLog` always reading the single legacy `query_log.jsonl`, never the tenant-derived file `logQuery` now writes). Both got the identical `tenantId`-first path contract as the 7 Task-1 modules (`tenant-state-path.ts`), with local-only callers (`stop-hook.ts`, `session-end-hook.ts`, `src/cli/scope-coverage.ts`) threading `DEFAULT_TEAM_ID` as their real identity.

Also fixed, both flagged inline by Task 1 as "no new plumbing needed":
- `SqliteOutcomeCitationReader` / `buildSqliteOutcomeDeps` (`sqlite-outcome-store.ts`) — `tenantId` now captured at construction (mirrors how `logPath` is already held) instead of the shared `OutcomeCitationReader` port signature, since that port is used by `deriveOutcome` which already receives `tenantId` as its own explicit outer argument.
- `GET /api/recall/cite-stats` in `http/app.ts` — reads the same `citation-log.jsonl` as the M6-FILTER routes but was never gated at all, so it was already live-commingling tenants today. Same fix as the amendment's three flagged routes: swap `DEFAULT_TEAM_ID` for `c.get("tenantId")`.

## Changes per surface

**`src/http/app.ts`**
- `HOSTED_GATED_ROUTES`: removed all 8 M6-FILTER rows; `HostedDisposition` narrowed to `"LOCAL"` only. Block comment above rewritten to describe file-state as now tenant-attributed instead of M6-FILTER-pending.
- Every route handler that touches file-state now reads `c.get("tenantId")` and threads it into `logQuery` / `recallStats` / `recentQueryLog` / `appendCitation` / `citationStats` / `resolveConversationForSession` / `loadSurfaced` / `recordSurfaced` / `clearSurfaced` / `clearCited` / `logFactQuery` / `factRecallStats`, in place of the `DEFAULT_TEAM_ID` placeholder: `/api/recall`, `/api/recall/stats`, `/api/recall/recent`, `/api/recall/cite-event`, `/api/recall/cite-stats`, `/api/citation/explicit`, `/api/hook/pre-compact`, `/api/hook/hermes-agent/pre-turn`, `/api/hook/hermes-agent/post-turn`, `/api/hook/hermes-agent/session-lifecycle`, `/api/recall/facts`, `/api/recall/facts/stats`.
- `POST /api/hook/pre-compact` writes a differently-shaped record (`{ ts, kind: "pre-compact", conversationId, flushed }`) than `appendHookLog`'s `HookLogEntry`, so it can't reuse that function directly. Its raw `appendFileSync` path derivation is now the same tenant-aware ternary every other module uses (`tenantId === DEFAULT_TEAM_ID ? (env override ?? tenantStatePath(...)) : tenantStatePath(...)`), replacing the old `NLM_HOOK_LOG`-only literal.
- `/api/dataset` (LOCAL disposition, pre-existing/pre-M6) left untouched — deliberately whole-DB, never reachable in hosted mode; not a Task-1 placeholder.

**`src/mcp/server.ts`**
- `recallSessionsHandler`, `recallWorkstreamHandler`, `recallFactsHandler`, the `recall_code` tool handler: swapped `DEFAULT_TEAM_ID` for the `tenantId` already resolved a few lines above each `logQuery`/`logFactQuery` call (exactly the "no new plumbing" case Task 1 flagged).
- `citeSessionHandler`: `_tenantId` renamed to `tenantId` and wired into `appendCitation`/`resolveConversationForSession`; its `isHostedMode()` gate (which unconditionally errored under `NLM_HOSTED=1` naming M6) is removed — citation-log.jsonl is now genuinely tenant-attributed, so the M6-FILTER-class refusal is no longer correct. `isHostedMode`/`DEFAULT_TEAM_ID` imports dropped (both now unused).
- `getSessionHandler`'s call to `buildSqliteOutcomeDeps(deps.outcomeDb)` now passes the already-in-scope `tenantId` as a second argument.

**`src/core/storage/sqlite-outcome-store.ts`**
- `SqliteOutcomeCitationReader` constructor takes `tenantId` (captured as an instance field, same pattern as `logPath`); `listForSession` uses it instead of `DEFAULT_TEAM_ID`.
- `buildSqliteOutcomeDeps(db, tenantId, opts)` — new required second parameter, threaded into the citation reader.
- `loadOutcomeCoverageInput`: swapped `DEFAULT_TEAM_ID` for the `tenantId` already a parameter on that function.

**`src/core/hook/cite-memo.ts`** — `loadCited`/`recordCited`/`clearCited` all take `tenantId` as first parameter; `stateDir()`/`memoPath()` now derive via `tenantStatePath` + `NLM_HOOK_STATE_DIR` override for the default team, identical contract to `memo.ts`.

**`src/core/recall/recent-log.ts`** — `recentQueryLog(tenantId, limit, logPath?)`; `defaultLogPath(tenantId)` mirrors `query-log.ts`'s contract exactly (same file, same env var).

**Local-only composition roots** (threaded `DEFAULT_TEAM_ID` as real identity, not a placeholder — no comment or behavior otherwise changed except where a new required param needed it): `src/hook/stop-hook.ts`, `src/hook/session-end-hook.ts`, `src/hook/pre-compact-hook.ts`, `src/hook/session-start-hook.ts`, `src/hook/prompt-recall-hook.ts`, `src/cli/scope-coverage.ts`. `src/cli/nlm.ts` and `src/cli/digest.ts` needed no changes — Task 1 already threaded these correctly with no placeholder comments (confirmed via grep; both are genuine single-tenant local CLI tools per Task 1's own concern note, and the brief's Task 2 list agrees).

## `DEFAULT_TEAM_ID` survivor list (verified non-request-scoped)

`grep -n DEFAULT_TEAM_ID src/http/app.ts src/mcp/server.ts` after this pass:

**`src/http/app.ts`**
- Line 116: import statement.
- Lines 163, 379, 464, 470: doc comments describing `installLocalOnlyMiddleware`'s tenant-resolution contract (M3-era, pre-existing, unrelated to M6).
- Lines 513, 533: inside `installLocalOnlyMiddleware` itself — `c.set("tenantId", DEFAULT_TEAM_ID)` is the actual *definition* of what an unauthenticated/local-mode request resolves to. Not a placeholder; this is the one place in the codebase that's allowed to originate `DEFAULT_TEAM_ID` for a request that carries no token.
- Line 969: `/api/hook/pre-compact`'s tenant-aware path ternary (`tenantId === DEFAULT_TEAM_ID ? ... : ...`) — a comparison, not an assignment; mirrors every other module's path contract.
- Line 1244: `/api/dataset` (`GET`, LOCAL disposition) — pre-existing (pre-M6), deliberately whole-DB, never reachable in hosted mode. Not a Task-1 placeholder (no such comment existed here before this task, and Task 1's report doesn't list it).

**`src/mcp/server.ts`**
- No live code references remain. One stale doc comment at line 897 (`createMcpServer`'s docstring: "Callers ... pass DEFAULT_TEAM_ID until M3 replaces it with the token-resolved team") predates M6 entirely — M3 already landed token resolution for the HTTP `/mcp` mount. Left untouched: unrelated to M6-FILTER, and fixing pre-existing M3-era doc staleness is out of this task's scope.

## Test evidence

```
npx tsc --noEmit
# clean, zero errors

npx vitest run tests/integration/hosted-mode-gate.test.ts tests/integration/tenant-leak-contract.test.ts \
  tests/integration/tenant-leak-contract.pg.test.ts tests/integration/cite-memo.test.ts \
  tests/integration/session-end-hook.test.ts tests/integration/stop-hook.test.ts \
  tests/unit/core/recall/recent-log-tenant-path.test.ts tests/unit/core/storage/sqlite-outcome-store.test.ts \
  tests/integration/re-derivation-persist.test.ts
# Test Files  1 failed | 8 passed (9)   <- the 1 failure is tenant-leak-contract.pg.test.ts's own
#                                          ECONNREFUSED 127.0.0.1:54329 (no local Postgres), pre-existing
# Tests       107 passed | 11 skipped | 1 todo (119)   <- the todo is case 12, Task 3's job

npm test -- --run
# Test Files  27 failed | 264 passed | 1 skipped (292)
# Tests        7 failed | 2271 passed | 229 skipped | 1 todo (2508)
```

All 27 failing test files are `*.pg.test.ts` (or the `pg cycle guard` describe block in `tests/integration/supersedence-cycle-guard.test.ts`), every one failing with `ECONNREFUSED 127.0.0.1:54329` — identical to the pre-existing baseline Task 1's report documented (27 files / 7 tests). Confirmed identical via `grep "FAIL "` output: same file set, same tests. Zero non-pg regressions.

Also ran the broader surrounding test sets touched by comment-only or adjacent changes (`mcp-recall-logging.test.ts`, `mcp.test.ts`, `recall-workstream-mcp.test.ts`, `recall-defaults.test.ts`, `citation-explicit.test.ts`, `http.test.ts`, `pre-compact-hook.test.ts`, `hook-pre-compact.test.ts`, `hermes-agent-hooks.test.ts`, `cite-event.test.ts`, `hook-claude-settings.test.ts`, `prompt-recall-hook.test.ts`, `session-start-hook.test.ts`, `precision.test.ts`, `build-recall-query.test.ts`, `deadline-invariant.test.ts`, `session-start-failure-modes.test.ts`, `codex-plugin.test.ts`, `mcp-cite-session.test.ts`, `citation-detect-cite-session.test.ts`) — all green.

New/updated tests, per module:
- `tests/unit/core/recall/recent-log-tenant-path.test.ts` (new) — default-team env-override, non-default-tenant derived path, two-tenant no-collision, explicit-logPath-override-wins cases (same 4-case convention as `query-log-tenant-path.test.ts`).
- `tests/integration/cite-memo.test.ts` — existing calls threaded with `DEFAULT_TEAM_ID`; new `cite-memo.ts tenant path contract` describe block (default-team override, non-default tenant derived path, two-tenant no-collision).
- `tests/integration/session-end-hook.test.ts`, `tests/integration/stop-hook.test.ts` — existing `loadCited`/`recordCited`/`clearCited` calls threaded with `DEFAULT_TEAM_ID`.
- `tests/unit/core/storage/sqlite-outcome-store.test.ts` — existing `SqliteOutcomeCitationReader`/`buildSqliteOutcomeDeps` calls threaded with `DEFAULT_TEAM_ID`; new case asserting a cross-tenant citation is invisible to the default-team reader and visible only via the tenant-scoped reader.
- `tests/integration/re-derivation-persist.test.ts` — existing `buildSqliteOutcomeDeps` calls threaded with `DEFAULT_TEAM_ID`.
- `tests/integration/hosted-mode-gate.test.ts` — the former `M6_FILTER_ROUTES` 403-assertion loop is now `FORMERLY_M6_FILTER_ROUTES`, asserting a real `200` (not just non-403) with a resolvable token, driven by a valid minimal payload per route (`FORMERLY_M6_FILTER_BODIES`) so the assertion can't pass on a validation-error 400 masking a lingering 403. The two `cite_session`-in-hosted-mode tests flip from "errors naming M6" to "works normally." Added env-var redirection (`NLM_QUERY_LOG`/`NLM_CITATION_LOG`/`NLM_FACT_QUERY_LOG`/`NLM_HOOK_LOG`/`NLM_HOOK_STATE_DIR`) in `beforeEach`/`afterEach` so these now-live assertions write into a tmp dir instead of the developer's real `~/.nlm/*` — verified via `wc -l` before/after that no new lines land in the real files.

## Self-review

Ran `git diff 702786f -- <every touched file>` end to end (shown in full during implementation, not repeated here). Findings:
- Every `DEFAULT_TEAM_ID` → `tenantId` swap in `app.ts`/`server.ts` was checked against the enclosing handler/function to confirm a real, request-scoped `tenantId` was actually in scope (either already declared via `c.get("tenantId")` a few lines up, or a function parameter) before the swap — none were blind renames.
- Confirmed no other caller in the repo (scripts/, tests not already checked) still calls the old arities of `recentQueryLog`, `loadCited`/`recordCited`/`clearCited`, `buildSqliteOutcomeDeps`, `SqliteOutcomeCitationReader` — grepped explicitly, all consistent.
- Confirmed local mode byte-identical: `DEFAULT_TEAM_ID` traffic still resolves to the exact legacy paths (env overrides still honored for the default team in every touched module's path-derivation function), and no file format changed.
- No new dependencies added.

## Concerns

None blocking. One pre-existing gap noted but left alone (out of this task's scope): `src/mcp/server.ts`'s `createMcpServer` docstring (line ~897) still says callers "pass DEFAULT_TEAM_ID until M3 replaces it with the token-resolved team" — M3 already landed this; the comment is stale from before M6 and not something Task 2 introduced or was asked to fix.

Task 3 (flip leak-contract case 12 `it.todo` + pg twin) can now proceed — every file-state module case 12 needs (memo, cite-memo, query/citation/miss/hook-recall/fact-query logs) has the tenant contract in place end to end, HTTP-level.
