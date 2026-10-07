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

