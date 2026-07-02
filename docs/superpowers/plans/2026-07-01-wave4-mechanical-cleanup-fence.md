# Wave 4 — Mechanical Cleanup Fence (Qwen ralph loop)

Engine: Qwen3.6-27B, MTPLX Quality profile, Mac Studio. Loop runs on the Mac Mini (repo host).
Supervisor: Product Manager agent via /ralph-loop-pm, auditing each landed commit against the acceptance criteria below.
Source: 2026-07-01 senior code review (NocoDB task "Mechanical cleanup batch"). All items are fenced, test-gated, semantics-free.

## R-rules (loop-terminating on violation)

- R1: Touch ONLY files named in an item's fence. Never touch: `src/ui/**`, `migrations/**`, `src/core/storage/sqlite-fact-store.ts` supersedence logic (ingestSessionFactsInTxn and below), anything under `plugin*/`, `.mcp.json`, `package.json` deps.
- R2: One item per commit, message `chore(cleanup): <item-N> <title>`. Suite + typecheck green before each commit lands.
- R3: No new dependencies. No port interface changes. No public API changes beyond what an item states.
- R4: If an item's acceptance criteria cannot be met without exceeding its fence, SKIP it, log why, move on. Never widen a fence.
- R5: No comments narrating changes; match surrounding style; no em dashes in any text.

## Items

### Item 1 — Delete dead `insertRowInTxn`
Fence: `src/core/storage/sqlite-fact-store.ts` (lines ~65-73 + its doc comment).
Accept: function and stale comment gone; grep confirms zero callers in src/ and tests/; suite green.

### Item 2 — Delete duplicate `WorkstreamRecallView`
Fence: `src/core/workstream/compose-recall.ts`, `src/core/workstream/model.ts`, direct importers of WorkstreamRecallView.
Accept: compose-recall consumes `WorkstreamRollup` from model.ts; type deleted; typecheck clean.

### Item 3 — Collapse backfill-workstreams DI harness
Fence: `src/core/workstream/backfill-workstreams.ts` (delete), `src/core/workstream/bind.ts` (add optional `source` param to BindDeps, default "classifier"), `scripts/backfill-workstreams.ts` (call bindSessionToWorkstream directly with source "backfill"), associated tests.
Accept: backfill-workstreams.ts deleted; script loop calls bind directly; binding_source values unchanged in DB writes ("classifier" live, "backfill" script); existing bind + backfill tests updated and green.

### Item 4 — Strip dead matcher-era surface from bind
Fence: `src/core/workstream/bind.ts`, `src/core/scheduler/scheduler.ts` (~lines 325-348), their tests.
Accept: `BindResult.created`/`confidence` removed (return workstreamId string|null or narrowed type); unreachable second try/catch at scheduler.ts:344-348 removed (bind.ts already catches internally and returns null); `hints[].aliases` field removed from the hint type and both LLM client prompt branches that render "(aka ...)" for it (deepseek-client.ts, ollama-client.ts) since it is always empty in every production path; tests green.

### Item 5 — Hook shared-helper dedup
Fence: `src/hook/*.ts` (prompt-recall-hook, session-start-hook, session-end-hook, stop-hook, recall-over-http, recall-gate), new small modules under `src/hook/`.
Accept:
- one `readStdin` in a shared module (currently 4 copies), resolve-on-error contract preserved and tested;
- session-start-hook's private recallOverHttp deleted; shared client in recall-over-http.ts extended with a mode param covering its use;
- one `fetchWithTimeout(url, init, ms)` used by all 5 AbortController+setTimeout sites;
- one `hookModeFromEnv()` replacing the 5 inline `NLM_HOOK_MODE` parses;
- one `appendHookEvent` helper replacing the duplicated log-append blocks (stop-hook ~163-188, session-end ~43-65), consistent with @core/hook/hook-log.ts.
Fail-open contract intact: every hook main() still wraps everything in try/catch with clean exit. Hook tests green.

### Item 6 — localhost -> 127.0.0.1
Fence: `src/hook/session-start-hook.ts` (~lines 100, 138), `src/hook/stop-hook.ts` (~line 207).
Accept: no `http://localhost` remains under src/hook/ (grep); matches the documented fix in recall-over-http.ts:39-42.

### Item 7 — Shared test LLM stubs
Fence: new `tests/fixtures/llm-stubs.ts`; the ~20 test files re-declaring StubClassifier/StubEmbedder/FixedEmbedder.
Accept: one canonical stub set; migrated files import it; per-file stub classes deleted; full suite green. If a file's stub has genuinely divergent behavior, leave that file and log it (R4).

### Item 8 — Dedup `l2Normalize`
Fence: `src/llm/ollama-code-embedder.ts` (delete private copy ~lines 34-45, import the exported one from ollama-client.ts as openai-code-embedder-client.ts already does).
Accept: one l2Normalize in src/llm; embedder tests green.

## Explicitly excluded (needs judgment — routed to SDD waves, do not attempt)

- insertSessionForTest wrapper (I-17): 34 dependent test files may encode the divergent entity-status behavior; SDD.
- check-invariants SQL consolidation (S-8): touches invariant semantics; SDD.
- Anything in ingestSessionFactsInTxn, supersedence cascade, or embedding lifecycle: Waves 1-3 SDD territory.
- Wiring hints[].aliases from work-topics (product decision, not cleanup).
- SessionStore.list() removal and retired_at SELECT columns: REMOVED FROM THIS FENCE 2026-07-01 to avoid session/fact-store conflicts with concurrent Wave 2b; retired_at moved to Wave 2b Task 6; list() removal deferred to post-wave cleanup.

## Loop exit

All 8 items committed or R4-skipped with logged reasons; final full gate: `npm run typecheck` + `npm test` green (known cli-work-digest flake tolerated, isolation-verified); PM agent whole-batch audit passes.
