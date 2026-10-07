# Task 4 Report — supersedence-log tenancy

## Summary

Threaded tenant identity through `src/core/storage/supersedence-log.ts` following the exact Task-1/Task-2 pattern (`tenantStatePath`, `DEFAULT_TEAM_ID`, `citation-log.ts` / `hook-log.ts` as templates). All three exported functions now take a non-optional `tenantId: string` as their first parameter.

## Changes

### `src/core/storage/supersedence-log.ts`
- Replaced the ad-hoc `defaultLogPath()` (env-or-`~/.nlm/supersedence-log.jsonl`) with `defaultLogPath(tenantId)`, mirroring `citation-log.ts`/`hook-log.ts`:
  - default team → `NLM_SUPERSEDENCE_LOG` env override, else `tenantStatePath(tenantId, "supersedence-log.jsonl")` (= legacy `~/.nlm/supersedence-log.jsonl`, byte-identical).
  - any other tenant → `tenantStatePath(tenantId, "supersedence-log.jsonl")` = `~/.nlm/tenants/<sanitized>/supersedence-log.jsonl`, env override never applies.
- `readSupersedenceLog(tenantId, logPath = defaultLogPath(tenantId))`
- `appendFactSupersedence(tenantId, entry, logPath = defaultLogPath(tenantId))`
- `appendSupersedence(tenantId, entry, logPath = defaultLogPath(tenantId))`
- Error-handling contract unchanged: read path still returns `[]` on missing/unreadable file; write paths still swallow and warn to stderr with the same message text. No new dependencies — only added the two existing `@core/tenancy/*` imports already used by every other threaded module, dropped the now-unused `join`/`homedir` imports.
- Updated the stale doc comment in `getSessionHandler` (see below) — no behavior change to the fencing logic itself, since the brief only required the log read to become tenant-scoped.

### Call sites (tenant value each passes)

| Call site | File:line | Function | Tenant passed |
|---|---|---|---|
| `getSessionHandler` supersedence enrichment | `src/mcp/server.ts:399` | `readSupersedenceLog(tenantId)` | request-resolved `tenantId` param (already threaded into the handler in Task 2) |
| `markSupersededHandler` (MCP `mark_superseded`) | `src/mcp/server.ts:704` | `appendSupersedence(tenantId, {...})` | request-resolved `tenantId` param |
| `supersedeFactHandler` (MCP `supersede_fact`) | `src/mcp/server.ts:761` | `appendFactSupersedence(tenantId, {...})` | request-resolved `tenantId` param |
| HTTP `POST /api/session/:id/supersede` | `src/http/app.ts:1690` | `appendSupersedence(tenantId, {...})` | `c.get("tenantId")`, same value the route already uses for `deps.store.markSuperseded(tenantId, ...)` two lines above |
| CLI `executeSupersede` | `src/cli/supersede.ts:154` | `appendSupersedence(DEFAULT_TEAM_ID, {...})` | `DEFAULT_TEAM_ID` — local-only composition root; every other store/recall call in this file (`markSuperseded`, `getById`, `recall.search`, `getByIds`) already hardcodes `DEFAULT_TEAM_ID`, so this matches the file's existing convention exactly |

No other call sites exist — grepped `appendSupersedence|appendFactSupersedence|readSupersedenceLog` across `src/` and `tests/`; the only other hit is a comment in `tests/integration/mcp.test.ts:386` describing fire-and-forget behavior, not a call.

### `src/mcp/server.ts` doc comment (getSessionHandler)
The pre-existing comment above the `supersededBy` enrichment block said the shared log "is not itself tenant-partitioned" as the reason for the `byId`-fencing defense. That's no longer accurate (the log is now tenant-partitioned), so I reworded it to describe the fencing as defense-in-depth against any pre-M6 legacy log entry, rather than delete the fencing logic itself — the brief only asked for the read call to become tenant-scoped, not for the fencing to be removed, and removing it would be an unrequested behavior change.

### Tests — `tests/unit/core/supersedence-log.test.ts`
- Updated all 8 pre-existing calls to `appendSupersedence`/`appendFactSupersedence` to pass `DEFAULT_TEAM_ID` as the new first arg (they already passed an explicit `logPath` as the override arg, so behavior is unchanged — same tmpdir paths as before).
- Added a new `describe("supersedence-log tenant path contract", ...)` block with the required (a)/(b)/(c) trio, patterned directly on `citation-log.test.ts`'s `"appendCitation tenant path contract"` block:
  - (a) `"default team honors NLM_SUPERSEDENCE_LOG override (legacy behavior)"` — sets the env var, calls `appendSupersedence(DEFAULT_TEAM_ID, {...})` with no explicit `logPath`, asserts the env-pointed file was written.
  - (b) `"a non-default tenant writes under ~/.nlm/tenants/<t>/supersedence-log.jsonl, ignoring NLM_SUPERSEDENCE_LOG"` — same env var set, calls with a non-default tenant, asserts the env-pointed file was NOT written and the derived tenant path WAS.
  - (c) `"two tenants' supersedence logs don't collide"` — writes distinct entries for two tenants, reads each back via `readSupersedenceLog(tenantId)`, asserts no cross-contamination (this also exercises `readSupersedenceLog`'s tenant path, which had zero prior test coverage).

## Verification

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run tests/unit/core/supersedence-log.test.ts` — 11/11 passed (8 existing + 3 new tenancy tests).
- `npx vitest run tests/integration/mcp.test.ts tests/unit/core/recall/citation-log.test.ts` — 33/33 passed (mcp.test.ts exercises `markSupersededHandler`/`supersedeFactHandler`/`getSessionHandler` end-to-end through the new signatures; stderr warning lines seen in output are expected assertions in existing error-path tests, not failures).
- Full suite: `npm test -- --run 2>&1 | tail -10` → **7 failed | 2274 passed | 229 skipped | 1 todo (2511 total)**. All 7 failures are `ECONNREFUSED 127.0.0.1:54329` in `tests/integration/pg-migrate.pg.test.ts` (3) and `tests/integration/supersedence-cycle-guard.test.ts` (4) — pre-existing Postgres-connectivity failures unrelated to this change (no local Postgres running), matching the brief's stated 7 pre-existing failures exactly. Nothing else broke.

## Commits

- `8324200` — `feat(tenancy): thread tenant identity through supersedence-log.ts` (source: module + 3 call sites)
- `7cafc72` — `test(tenancy): cover supersedence-log tenant path contract` (test file)

Both end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. `git diff 0cb998e..HEAD --stat`: 5 files changed, 106 insertions, 36 deletions.

## Concerns

None. This closes out the last of the shared file-state modules per the Task 4 brief; no scope was left unaddressed (single module, single brief line, exactly 4 call sites found and all threaded).
