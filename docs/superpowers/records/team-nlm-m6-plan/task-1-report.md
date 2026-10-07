# Team NLM M6 — Task 1 report: state-file tenancy path contract

Status: DONE

Commits (main, no PR — repo convention):
- `db72e41` feat(tenancy): add tenant-state-path path-contract helper
- `c2a5d18` feat(tenancy): thread tenantId through file-state modules (M6 Task 1)

## What changed, per module

New module `src/core/tenancy/tenant-state-path.ts`:
- `tenantStatePath(tenantId: string, ...segments: string[]): string` — `DEFAULT_TEAM_ID` resolves to `~/.nlm/<segments>` (legacy path, byte-identical); any other tenant resolves to `~/.nlm/tenants/<sanitized-tenantId>/<segments>`.
- `TENANTS_DIRNAME` exported constant (`"tenants"`).
- Sanitization mirrors memo.ts's existing conversation-id rule: `[^A-Za-z0-9_-] -> "_"`, falling back to `"unknown"` when the id sanitizes to empty.
- mkdir is left to callers, per the brief.

The 7 modules named in the brief, each given `tenantId: string` as the **first parameter on every exported read/write function**, with their default-path helper switched to `tenantId === DEFAULT_TEAM_ID ? (env override ?? tenantStatePath(...)) : tenantStatePath(...)` (non-default tenants always ignore the env override):

- **`src/core/hook/memo.ts`** — `loadSurfaced`, `recordSurfaced`, `resolveConversationForSession`, `clearSurfaced`. State dir: `NLM_HOOK_STATE_DIR` (default team) / `~/.nlm/tenants/<t>/hook-state/` (other tenants).
- **`src/core/hook/hook-log.ts`** — `appendHookLog` (no readers). Path: `NLM_HOOK_LOG` / `~/.nlm/tenants/<t>/hook-log.jsonl`.
- **`src/core/recall/query-log.ts`** — `logQuery`, `readQueryLog`, `recallStats`. Path: `NLM_QUERY_LOG` / `~/.nlm/tenants/<t>/query_log.jsonl`.
- **`src/core/recall/citation-log.ts`** — `appendCitation`, `readCitationLog`, `citationStats`. Path: `NLM_CITATION_LOG` / `~/.nlm/tenants/<t>/citation-log.jsonl`. `isAttributableConversationId` left unchanged — it's pure validation, not I/O, so it isn't a "read/write function" under the brief's global constraint.
- **`src/core/recall/miss-log.ts`** — `appendMiss`, `appendMisses`, `missStats`. Path: `NLM_MISS_LOG` / `~/.nlm/tenants/<t>/miss-log.jsonl`. `isEnabled()`/`NLM_MISS_LOG_ENABLED` untouched (independent of path).
- **`src/core/recall/hook-recall-log.ts`** — `readHookRecallLog` (reader only). Path: `NLM_HOOK_LOG` / `~/.nlm/tenants/<t>/hook-log.jsonl`.
- **`src/core/recall-facts/fact-query-log.ts`** — `logFactQuery`, `factRecallStats`. Path: `NLM_FACT_QUERY_LOG` / `~/.nlm/tenants/<t>/fact_query_log.jsonl`.

All 7 doc comments updated to describe the tenant-derived path story. `src/core/recall/recent-log.ts` was deliberately **not** touched — it wasn't in the brief's module list, has its own independent `defaultLogPath()`, and none of its callers needed a signature change.

## Placeholder files (Task 2 must replace with real tenant resolution)

Per the brief's closing paragraph, every non-test caller that went red under `tsc --noEmit` was threaded mechanically with the `DEFAULT_TEAM_ID` literal (imported from `@core/tenancy/default-team.js`), each site comment-marked `// M6 Task 1 placeholder`. No caller logic, gating, or control flow was changed — only the new required argument was added.

- `src/mcp/server.ts` — `recallSessionsHandler`, `recallWorkstreamHandler`, `recallFactsHandler`, `citeSessionHandler` (its `_tenantId` param stays unused/underscore-prefixed, matching the pre-existing `M6-FILTER` comment already there), and the `recall_code` handler's `logQuery` call.
- `src/http/app.ts` — `/api/recall`, `/api/recall/stats`, `/api/recall/cite-event`, `/api/recall/cite-stats`, `/api/citation/explicit`, `/api/hook/pre-compact`, `/api/hook/hermes-agent/pre-turn`, `/api/hook/hermes-agent/post-turn`, `/api/hook/hermes-agent/session-lifecycle`, `/api/recall/facts`, `/api/recall/facts/stats`. All of these are covered by the existing `installHostedModeGate`'s `M6-FILTER` disposition — hosted-mode traffic is already hard-disabled on these routes, so the placeholder only affects local-mode telemetry.
- `src/cli/nlm.ts` — `misses` and `precision` commands (`missStats`, `readHookRecallLog`, `readQueryLog`, `readCitationLog`).
- `src/cli/digest.ts` — `readHookRecallLog(7)`, `readCitationLog(7)` inside `runDigest`.
- `src/core/storage/sqlite-outcome-store.ts` — `SqliteOutcomeCitationReader.listForSession` and `loadOutcomeCoverageInput`.
- `src/hook/pre-compact-hook.ts`, `src/hook/prompt-recall-hook.ts`, `src/hook/session-end-hook.ts`, `src/hook/session-start-hook.ts`, `src/hook/stop-hook.ts` — all five hook entrypoints have zero tenant context today (no `tenantId` anywhere in `src/hook/`), so every memo/log call there is pinned to `DEFAULT_TEAM_ID`.

### Concerns for Task 2 (not acted on in Task 1, per "do not redesign")

- **`loadOutcomeCoverageInput` in `sqlite-outcome-store.ts`** already receives a real `tenantId` as its second parameter — the `DEFAULT_TEAM_ID` placeholder there is one line Task 2 can trivially replace with the value already in scope (flagged inline).
- **`recallSessionsHandler`, `recallWorkstreamHandler`, `recallFactsHandler`** (mcp/server.ts) and the `/api/recall`, `/api/recall/facts` routes and Hermes `pre-turn` route (http/app.ts) all resolve a real `tenantId` a few lines above the placeholder call. I did not use it, per the brief's explicit instruction to thread `DEFAULT_TEAM_ID` mechanically and not redesign these files — but it means Task 2's fix in these specific spots is "swap the literal for the variable already in scope," not new plumbing.
- **`citeSessionHandler`'s `_tenantId` param and the hosted-mode gate above it** (`isHostedMode()` -> `"cite_session is disabled in hosted mode until M6 ... lands"`) were left completely untouched — that gate's removal is presumably a downstream M6 task once citation-log.jsonl is genuinely tenant-attributed, not Task 1's job.
- **`src/cli/nlm.ts` / `src/cli/digest.ts`**: these are genuinely single-tenant local CLI tools (no per-tenant CLI concept exists anywhere in this codebase). Pinning to `DEFAULT_TEAM_ID` here isn't really a "temporary hack" the way the hook/http/mcp placeholders are — flagging in case Task 2's audit expects it to stay that way rather than get "fixed."
- **`src/core/hook/memo-sweep.ts`** was intentionally left untouched: it isn't in the brief's module list, has its own independent `defaultStateDir()` (duplicated from memo.ts, not imported), and only ever sweeps the default team's `hook-state/` dir. Non-default tenants' memo dirs under `~/.nlm/tenants/<t>/hook-state/` currently have no sweep backstop. Not in scope for Task 1, but worth a follow-up ticket once multi-tenant memo traffic exists.

## Test evidence

TDD: wrote `tests/unit/core/tenancy/tenant-state-path.test.ts` and all module path-contract cases before touching implementation; watched them fail (`tenantId.replace is not a function` / `TS2554: Expected N arguments, but got 1` compile errors) before implementing.

Commands run, from `c2a5d18` (HEAD):

```
npx tsc --noEmit
# clean, zero errors

npx vitest run tests/unit/core/hook tests/unit/core/recall tests/unit/core/recall-facts tests/unit/core/tenancy
# Test Files  34 passed (34)
# Tests       280 passed (280)

npm test -- --run
# Test Files  27 failed | 263 passed | 1 skipped (291)
# Tests        7 failed | 2262 passed | 229 skipped | 1 todo (2499)
```

All 27 failing test files are Postgres-dependent (`*.pg.test.ts` plus the `pg cycle guard` describe block in `tests/integration/supersedence-cycle-guard.test.ts`), failing with `ECONNREFUSED 127.0.0.1:54329` — no local Postgres running in this environment. Confirmed pre-existing via `git stash` + re-run against `49e12f3` (pre-Task-1 HEAD): identical 4 failures in `supersedence-cycle-guard.test.ts` before any of my changes. Zero non-Postgres regressions.

New/updated unit tests, per module — each asserts (a) default team hits the legacy path (still honoring the env override), (b) a second tenant hits `tenants/<t>/...` and ignores the env override, (c) two tenants' writes don't collide:

- `tests/unit/core/tenancy/tenant-state-path.test.ts` (new)
- `tests/unit/core/hook/memo.test.ts` (new)
- `tests/unit/core/hook/hook-log.test.ts` (new)
- `tests/unit/core/recall/query-log-tenant-path.test.ts` (new)
- `tests/unit/core/recall-facts/fact-query-log-tenant-path.test.ts` (new)
- `tests/unit/core/recall/citation-log.test.ts` (existing calls threaded with `DEFAULT_TEAM_ID`; new `appendCitation tenant path contract` describe block added)
- `tests/unit/core/recall/hook-recall-log.test.ts` (existing calls threaded; new `readHookRecallLog tenant path contract` describe block added)
- `tests/unit/core/recall/miss-log.test.ts` (existing calls threaded; new `miss-log tenant path contract` describe block added)
- `tests/unit/core/recall/query-intent.test.ts` (existing `logQuery` calls threaded with `DEFAULT_TEAM_ID`; no new cases — path contract is covered by `query-log-tenant-path.test.ts`)

Integration tests updated to thread `DEFAULT_TEAM_ID` at existing call sites (no new cases — these test hook/module *behavior*, not the path contract):
`tests/integration/hook-log.test.ts`, `hook-memo.test.ts`, `pre-compact-hook.test.ts`, `session-end-hook.test.ts`, `stop-hook.test.ts`.

## Self-review

Ran `git diff 49e12f3..HEAD` end to end. Findings:
- All 7 module diffs are structurally identical (same `defaultLogPath`/`stateDir` pattern), consistent with each other and with `tenant-state-path.ts`.
- Verified every caller touched matches exactly the brief's list plus what `tsc` actually flagged — checked `src/core/digest/*`, `src/core/recall/precision.ts`, `src/core/recall/reranker.ts`, and `src/core/hook/citation-detect.ts` explicitly and confirmed none of them call these functions directly (precision.ts/reranker.ts only import types like `LogEntry`/`CitationEntry`/`HookRecallEntry`, which are unaffected), so they correctly needed no changes despite being listed in the brief as "if red."
- Confirmed `src/core/recall/recent-log.ts` (an eighth, closely-related module reading the same `query_log.jsonl` file) was correctly left out — not in the brief's verbatim module list, and its own signature/callers were unaffected.
- Confirmed `local mode byte-identical` holds: `DEFAULT_TEAM_ID` traffic resolves to the exact same paths as before (verified in tests via the "honors env override" cases), and no file format changed.
- No new dependencies added.

## Concerns

None blocking. Two forward-pointers left inline as comments for Task 2 (noted above): the `sqlite-outcome-store.ts` `loadOutcomeCoverageInput` one-line fix, and the several MCP/HTTP handlers where a real `tenantId` is already resolved a few lines above the placeholder call.

## Fix: review finding — missing two-tenant isolation case (hook-recall-log.test.ts)

Commit: `702786f` test(tenancy): add missing two-tenant isolation case to hook-recall-log

Task review flagged that `tests/unit/core/recall/hook-recall-log.test.ts`'s "readHookRecallLog tenant path contract" describe block only had cases (a) default-team env override and (b) a single non-default tenant's derived path — the required case (c), two tenants not colliding, was missing (unlike the parallel blocks in `hook-log.test.ts` and `miss-log.test.ts`, which already had all three).

Fix: added "two tenants' hook-recall logs don't collide" — writes distinct entries under `~/.nlm/tenants/tenant-a-hookrecall/hook-log.jsonl` and `~/.nlm/tenants/tenant-b-hookrecall/hook-log.jsonl`, reads both via `readHookRecallLog(tenantId, 30)`, and asserts each tenant only sees its own entry. Same pattern as the existing two-tenant cases elsewhere.

Commands run:

```
npx vitest run tests/unit/core/recall/hook-recall-log.test.ts
# Test Files  1 passed (1)
# Tests       7 passed (7)   (was 6 before the fix)

npx tsc --noEmit
# clean, zero errors
```
