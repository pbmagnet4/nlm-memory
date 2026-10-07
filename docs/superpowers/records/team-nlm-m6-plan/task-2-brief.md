## Task 2 — thread real tenant identity through callers + un-gate M6-FILTER

- `src/http/app.ts`: every M6-FILTER route handler passes `c.get("tenantId")` into the log/memo calls; **remove the five M6-FILTER entries from `HOSTED_GATED_ROUTES`** (`/api/recall/cite-event`, `/api/citation/explicit`, `/api/recall/stats`, `/api/recall/recent`, `/api/recall/facts/stats`, `/api/hook/pre-compact`, `/api/hook/hermes-agent/post-turn`, `/api/hook/hermes-agent/session-lifecycle` — all 8 M6-FILTER rows) and delete the now-empty disposition comments referencing M6-FILTER-pending state. LOCAL rows stay.
- `src/mcp/server.ts`: cite_session + any log-touching tools pass the request-resolved tenant.
- `src/cli/digest.ts`, `src/cli/nlm.ts`, `src/hook/*.ts` (prompt-recall, stop, pre-compact, session-start), `src/core/hook/citation-detect.ts`, `src/core/digest/*` readers, `src/core/recall/precision.ts`, `src/core/recall/reranker.ts`, `src/core/storage/sqlite-outcome-store.ts`: thread `DEFAULT_TEAM_ID` from each composition root (these are local-mode surfaces).
- Replace any Task-1 placeholders with the real value from the composition root.
- Update the hosted-gate tests that assert 403 on M6-FILTER paths: those routes now serve tenant-scoped responses in hosted mode (assert 200/valid shape with a resolvable token, and that the LOCAL rows still 403).


## Amendment from Task 1 review (binding)

The Task-1 reviewer found three hosted-live routes whose telemetry calls are placeholder-pinned to DEFAULT_TEAM_ID but which serve real tenants in hosted mode: `POST /api/recall` (logQuery at ~app.ts:815), `GET /api/recall/facts` (logFactQuery ~:1166), and `POST /api/hook/hermes-agent/pre-turn` (loadSurfaced/recordSurfaced ~:1030). These are NOT in the M6-FILTER gate list, so they'd commingle tenant telemetry today. Requirement: in src/http/app.ts, EVERY telemetry/memo call site in a route handler passes the request's resolved tenant (`c.get("tenantId")`), not just the M6-FILTER handlers. Grep for `DEFAULT_TEAM_ID` in app.ts after your pass — the only legitimate survivors are outside request handlers (e.g. composition-root construction that Task 1 marked and you've verified is not request-scoped).
