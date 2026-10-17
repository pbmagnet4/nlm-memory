# Task 5 — one request budget, concurrent lanes, honest partial evidence

Status: implementation, self-review, covering verification and final paired replay complete. Independent controller review is pending. No speed promotion, deployment, push, installed daemon/configuration changes, holdout access, or generative calls.

## Scope and architecture

The baseline is `69f4c3faa46f3424918172bb899a1086c092f42c` (reviewed Tasks 1–4). The controller's subsequent `ad776c0` changes only plan/spec milestone documentation.

`src/core/context/recall-context.ts` owns scope resolution, full exact-value probing, parallel fact/session execution, optional exact-alternative hydration, and source hydration. It depends on core services/storage ports, not MCP. The adapter validates `timeoutMs` once at its boundary (default 1500, range 100–5000), passes authenticated tenant and SDK cancellation, packs full records with the actual formatter, and records telemetry. Successful bounded lane execution and exact-value completeness remain separate contracts.

`RequestBudget` composes the earlier parent deadline and local cap using one injected monotonic clock; asynchronous waits are abort-aware and clean their timer/listener ownership in `finally`. An already-aborted request starts no lane or outbound embedding. A complete exact probe with one distinct value starts no session search or embedding. An incomplete probe never establishes uniqueness. Non-exact lanes overlap rather than adding their durations.

The services publish prepared lexical evidence before waiting for semantic work. Both partial lanes use the same normalized hybrid fallback scores and ordering as a completed semantic outage, rather than raw keyword scores. Fact corroboration counts are reused only within one `search` call for identical authenticated tenant/subject/predicate/value tuples. This count API has no workstream or other eligibility argument: its existing policy counts tenant-wide corroboration for the tuple, and that policy is unchanged. The request-local map caches zero explicitly, sends only missing distinct tuples, applies the existing boost to the current hits, and never retains evidence or counts across requests. A changed value therefore gets a fresh count. The core only publishes evidence after source hydration completes, and gates every publication against the live budget. A failed or late lane cannot erase the other lane or mutate the response. `coverage` names complete/partial/unavailable lanes and machine-readable failure/deadline reasons. Complete means the declared bounded retrieval contract finished, not exhaustive corpus recall; a safe unique lookup satisfies the session contract by skipping it. A failed semantic-only lane is unavailable. Missing fact service with exact-store evidence is partial; a missing fact service without evidence is unavailable.

A lazy request-local query embedding is shared only when exact query text (including whitespace), kind, and the same client object match. Services independently verify all three before reading the promise. Different clients, rewritten/trimmed text, different kinds, and different requests cannot reuse it. Both explicit hybrid and semantic modes share when eligible. The shared cap takes the minimum of the existing session cap, fact cap, and request deadline. Optional exemplar work composes its existing cap with the same execution options. Default facts-hybrid/sessions-keyword evidence policy is unchanged.

## Attribution removal

All MCP transcript-search attribution calls and the now-unreferenced synchronous scanner module/tests were removed with the controller's explicit ruling. Recall logging remains active with query, result IDs, runtime, and scope even when consumer conversation ID is missing. Trusted transport context is used only when its tenant matches the authenticated tenant. Citation paths retain an explicitly supplied existing `conversation_id`, matching trusted context, and the existing tenant-bound hook memo; missing attribution remains `logged:false` rather than claiming a dropped citation was stored.

No tool input gained tenant/conversation authority, no ambient transcript roots are walked, and no background crawler or filesystem task is scheduled. This deliberately loses heuristic consumer attribution in transports that provide no trusted context. The deterministic large/hanging-filesystem regression replaces `readdirSync`/`statSync` with failure sentinels for long queries, exercises context/session/fact/workstream/citation handlers, and proves no scan, no leftover request listener, and continued query/fact recording. A source-dependency assertion covers every MCP attribution callsite, including code recall registration.

## SQLite isolation and exact query-plan correction

The measured slow typed operations are session/fact semantic reads. Their existing SQL was extracted into `sqlite-semantic-sessions.ts` and `sqlite-semantic-facts.ts`; both the direct adapters and worker execute these same functions. The adaptive coherent read snapshot, strict unseen-distance completeness witness, deterministic tie handling, and exact fallback beyond sqlite-vec's native 4096 cap remain intact. Postgres behavior/schema did not change.

`SqliteSemanticReader` owns at most two workers and eight queued operations per storage instance. Messages identify only the server-owned session/fact read, tenant, vector, limit, and typed eligibility options; there is no arbitrary SQL broker. Worker connections are opened `readonly`/`fileMustExist` with `query_only=ON`, load sqlite-vec, and import no migration/write path. Already-aborted reads never queue or dispatch. Queued aborts remove the entry; active aborts settle the caller, remove its listener, and request worker termination. An occupied native call can delay `Worker.terminate()`: capacity remains held until actual exit, and `SqliteStorage.close()` waits for reaping. The tests deliberately hold termination pending to verify this distinction. Main-thread lexical/hydration/direct reads remain cooperative and may block the event loop. A JavaScript timer does not preempt native SQLite.

The initial real run exposed an avoidable exact scoped fact query-plan regression after migration 042's corroboration index. On a migrated disposable clone, SQLite started from every tenant fact through `idx_facts_corroboration`, looked up vectors, then checked source/workstream eligibility. Standalone diagnosis measured 5396 ms for that fact read and 338 ms for session read. The same frozen data before that migration selected sessions → facts by source → vector and was substantially faster. No migration was edited.

With the controller's approval, the exact fact query now uses sessions `CROSS JOIN` facts by source ID `CROSS JOIN` embeddings by fact ID. This forces source eligibility first while retaining every tenant/lifecycle/confidence/structured/scope predicate, exact L2 distances, deterministic order and limit. The controlled plan diagnostic measured original 5156/5008 ms versus source-first 68.4/67.8 ms, with all 36 returned IDs/distances identical. The change also applies when the adaptive unscoped path requires its exact fallback. The full scoped oracle covers small/large/empty scopes, foreign tenants and corrupt foreign sources, ties, unmapped winning chunks, and native-cap fallback on direct and worker paths.

Private plan evidence: `~/.nlm/eval/memory-context/2026-10-16-T806/task5-performance/sql-diagnostic.json` and `sql-join-plan-comparison.json`. Diagnostic runner sources are `/private/tmp/T806-task5-sql-diagnostic.mts` and `/private/tmp/T806-task5-sql-plan-comparison.mts`.

## TDD and verification evidence

RED before orchestration changes:

```sh
npx vitest run tests/unit/core/context/recall-context.test.ts
```

The new deterministic core suite failed because the required `recall-context` module did not exist (one failed suite, no collected tests). The same five tests subsequently passed: independent 100 ms lanes overlap; complete unique lookup skips sessions; one failed lane retains the other; already-aborted starts no lane/source read; late resolution cannot change a completed response. Fake timers are used, and every test asserts zero remaining timers.

The final covering command (before the narrow query-plan correction) was:

```sh
NLM_PG_TEST_URL=postgresql://nlm_test:nlm_test@127.0.0.1:54329/nlm_test npx vitest run tests/unit/core/context/recall-context.test.ts tests/integration/context-deadline.test.ts tests/unit/core/storage/sqlite-semantic-reader.test.ts tests/integration/scoped-semantic-recall.test.ts tests/integration/scoped-semantic-recall.pg.test.ts tests/integration/mcp-context.test.ts tests/integration/mcp-recall-logging.test.ts tests/unit/core/mcp-cite-session-attribution.test.ts tests/unit/core/mcp-no-ambient-attribution.test.ts tests/integration/mcp.test.ts tests/unit/core/recall-service.test.ts tests/unit/core/recall-facts/fact-recall-service.test.ts tests/unit/hook/deadline-invariant.test.ts tests/integration/tenant-guard.test.ts --test-timeout=20000
```

153 tests passed and the repository's tenant-helper import-shape guard rejected two relative imports. Those SQL functions already used `tenantClause`; the imports were corrected to the canonical `@core` form. The affected guard/context/direct+worker oracle rerun passed all 26 tests. A test-only optional-dependency type mismatch was also corrected, after which all TypeScript checks passed. Existing MCP tests emit asynchronous supersedence-log ENOENT warnings after their temporary directory cleanup; assertions pass, and this preexisting separate log lifecycle was not changed.

After the exact query-plan correction and self-review fixes:

```sh
npx vitest run tests/integration/scoped-semantic-recall.test.ts tests/integration/mcp-context.test.ts tests/integration/context-deadline.test.ts tests/integration/tenant-guard.test.ts
npm run typecheck
npm run build:server
git diff --check
```

Result: 48 tests across four files passed, including the exact worker/direct contract and actual registered MCP cancellation. Source/test/script TypeScript checks and server build passed. Additional focused runs passed the 53 existing service/no-ambient regressions and 15 worker lifecycle/direct+worker oracle tests. No network-dependent unit tests were added; local PostgreSQL contract tests executed against the supplied existing test container, which remains running. This repo has no `.agent-quality.yml`; no agent-quality configured gate is claimed.

Self-review checked scope failure closed behavior, complete-probe uniqueness, per-lane lexical fallback, identity-keyed embedding reuse, asynchronous abort/timer/listener cleanup, late response immutability, native worker termination semantics, queue saturation, worker errors/startup failure, storage shutdown, source tenant joins, schema/formatter character bounds, and the escaped maximum-length expansion-selector regressions. Optional display fields may be removed as whole fields to fit mandatory coverage; semantic selectors and evidence are never shortened.

Self-review added two corroboration cost/isolation tests and two partial-score preservation tests before fixing those defects:

```sh
npx vitest run tests/unit/core/recall-facts/corroboration-reuse.test.ts tests/unit/core/recall-service.test.ts
```

RED: four failed, 29 passed. The failures demonstrated duplicated identical tuple reads, cross-request expectations, and raw partial scores differing from the existing hybrid fallback. GREEN after the narrow corrections:

```sh
npx vitest run tests/unit/core/recall-facts/corroboration-reuse.test.ts tests/unit/core/recall-service.test.ts tests/unit/core/recall-facts/fact-recall-service.test.ts tests/integration/context-deadline.test.ts tests/integration/mcp-context.test.ts
npm run typecheck
npm run build:server
```

All 85 tests passed (five files), followed by all three TypeScript project checks and the server build. Counts of zero, changed triples, repeated requests and different tenants are covered. Raw RED output is retained at `/private/tmp/T806-task5-final-red.log`.

The controller's coverage-tax regression was also written before its correction:

```sh
npx vitest run tests/unit/core/context/coverage-packing.test.ts
```

RED: two failed (loss of the full 7948-character session envelope and loss at the existing fact allocation). GREEN: both passed with identical retained evidence and actual formatter size at or below 8000. A combined context, deadline, and worker lifecycle check passed 36 tests, including maximum escaped selector/history regressions. A missing required `supersededBy` field in the new test fixture was corrected; TypeScript checks and the server build then passed. RED evidence is at `/private/tmp/T806-task5-packing-red.log`.

## Real paired performance protocol

Command:

```sh
npx tsx scripts/eval/request-budget-performance.ts ~/.nlm/eval/snapshots/2026-10-15/canonical.sqlite ~/.nlm/eval/memory-context/2026-10-16-T806/task5-performance/run4
```

The script runs the actual pinned baseline handler from a git archive and the candidate handler in separate child processes. Both have identical isolated empty HOME/XDG/runtime transcript roots, explicit configured embedding environment, and separate disposable snapshot clones made before migrations. The snapshot itself is not migrated or modified. This comparison includes validation, attribution that remains, scope/probe, lanes, hydration, envelope formatting and logging initiation. It excludes process startup/migration and asynchronous log flush; cold stratum means fresh SQLite connections/workers, not flushed OS/provider caches.

Three explicit fixed workloads use `SQLite retrieval memory workstream`: default broad mode, explicit hybrid-both, and explicit hybrid in the snapshot's largest session-populated workstream. This is one repeated real query per mode/scope, not 30 independent questions. Each steady cohort runs 30 paired requests after five warmups and reverses arm order each pair. Separate strata contain six cold-connection pairs, 30 deterministic injected-outage pairs, and 30 four-concurrent-request pairs (120 requests per arm), each after five warmup batches. All failures, partial responses, and evidence mismatches remain in the denominator. SQL segments, worker durations, embedding attempts/failures, and full envelopes are recorded privately.

Only the existing configured embedder is used. Generative methods are blocked in the benchmark. The outage stratum injects a provider failure; it is not represented as an observed live gateway outage. Token usage is unavailable and recorded as null; characters are never substituted for tokens. Equality compares complete fact/session evidence records, not just result counts. It is a preservation diagnostic, not an independently adjudicated supported-answer score. No heldout data or frozen heldout labels were opened.

Run 1 did not freeze/fingerprint the source, and self-review source changes occurred during it; it is only a historical diagnostic, not final-candidate validation. The first run is retained at `task5-performance/run1/` as historical evidence of worker isolation before the join-order correction; it is not overwritten or substituted for the final candidate. It measured default broad p95 353.8 → 362.9 ms (2.6% slower), hybrid-both 564.5 → 408.5 ms (27.6% lower), scoped 9182.4 → 1509.1 ms with partial evidence, cold 612.0 → 504.2 ms, injected outage 101.0 → 103.5 ms, and four-concurrent 1302.1 → 1047.1 ms. The scoped apparent gain was deadline enforcement with evidence loss, not equal-quality speed. The default workload did not meet the 20% gate. Of 156 paired batches, 60 had different evidence: all 30 scoped pairs and all 30 outage pairs. Outage differences came from mandatory coverage consuming response-envelope space (whole facts/sessions remained intact); successful unscoped, cold, and loaded results matched. Embedding calls halved for eligible explicit hybrid requests. No broad speed promotion follows from these results.

The second run is also retained at `task5-performance/run2/`. Its source SHA-256 is `8d12ee457bb3354579efabb61e5a3b148672223d6ae15eccc153bacaf4087ba7`, with `candidateSourceChangedDuringRun:false`. It includes the exact SQL correction but precedes request-local corroboration reuse and partial-score preservation. P95 was default 300.3 → 359.7 ms (19.8% slower), hybrid 501.8 → 393.3 ms, scoped 6683.5 → 755.7 ms, cold 537.7 → 463.4 ms, outage 88.2 → 88.4 ms, and loaded 1282.4 → 1025.0 ms. Candidate scoped coverage was complete on all 30 responses, versus the earlier run's deadline partials. Baseline scoped embedding failed on 15/60 attempts while synchronous exact fact SQL blocked the main thread for several seconds; this instrumentation does not establish the provider failure cause. All 60 unequal pairs (30 scoped, 30 outage) remain counted; complete scoped coverage does not establish identical evidence or supported-answer superiority. This material default regression prompted the controller-approved removal of duplicate corroboration reads; no historical report was overwritten.

Run 3 at `task5-performance/run3/` includes request-local corroboration reuse and partial-score preservation. Source SHA-256 `f919cac9e4862a7473435edcadd4d5292d6b0227b9681cf7c3c46f663f61e2de` stayed unchanged throughout. P95 was default 334.0 → 357.3 ms (7.0% slower), hybrid 546.5 → 390.2 ms, scoped 7028.1 → 852.7 ms, cold 497.5 → 496.7 ms, outage 84.8 → 89.9 ms, and loaded 1234.7 → 989.2 ms. There were still 60 unequal pairs. The required coverage envelope alone tipped a prior 7948-character scoped response over 8000, removing a whole session. The controller required recovery from optional metadata before accepting that evidence tax.

The final candidate compensates coverage overhead at record-overflow checks using actual formatter measurements. It drops only whole optional display units (echoed query, display intent/budget, duplicated availability flags, display scope label, top-level expansion list), stopping once the record fits or the measured coverage overhead is compensated. A whole-field removal can overshoot the overhead by that field's size. This does not change the 45% fact allocation, total character limit, ranking, record values, source titles/bodies, mandatory scope IDs, exact lookup/history selector, or per-record expansion selector. Unrecoverable omissions remain explicitly counted. The top-level expansion list is optional; exact selectors attached to returned records and exact-value history remain intact.

## Final run 4 outcome

Private artifact: `task5-performance/run4/report.json` and `measurements.jsonl`. Measured pre-teardown-fix runtime source SHA-256 `b735f3de303279022671a65523a83582b984ad4c3797e27a6215b191a4326ce8`; `candidateSourceChangedDuringRun:false`. Completed 2026-10-17T03:22:51.895Z (October 16 local time). The actual prior handler remains pinned to `69f4c3faa46f3424918172bb899a1086c092f42c`, with identical isolated transcript environments.

| Cohort | Requests per arm | p50 baseline → candidate ms | p95 baseline → candidate ms | Candidate max ms | p95 change |
|---|---:|---:|---:|---:|---:|
| Default broad | 30 | 242.9 → 252.8 | 323.2 → 312.3 | 336.1 | -3.4% |
| Hybrid both | 30 | 371.6 → 291.8 | 496.0 → 384.2 | 486.1 | -22.5% |
| Hybrid scoped | 30 | 5642.7 → 527.9 | 5966.4 → 635.6 | 1533.8 | -89.3% |
| Cold connection | 6 | 427.0 → 374.4 | 506.3 → 436.6 | 436.6 | -13.8% |
| Injected outage | 30 | 81.7 → 85.0 | 90.2 → 93.0 | 94.6 | +3.1% |
| Four concurrent | 120 | 1079.9 → 823.5 | 1254.5 → 1030.2 | 1123.9 | -17.9% |

All 492 measured responses (246 per arm) and 156 paired batches remain in the denominator. There were zero tool-error responses. Exact complete evidence-record equality held for 155/156 paired batches and 245/246 responses. Default, explicit broad hybrid, cold, injected outage, and concurrent-load cohorts all retained identical fact/session records. The scoped cohort retained equality on 29/30 responses. No baseline records were lost in the other cohorts; total scoped baseline records were 150 facts/60 sessions versus candidate 150 facts/59 sessions. The one differing response replaced four of the baseline facts with lexical facts and omitted one baseline session. This is retained as evidence loss, not counted as an equal-quality speed win.

The differing scoped request was repetition 23: configured live embedding took 1305.7 ms and succeeded, main-thread SQL totaled 129.5 ms (maximum single segment 59.5 ms), and one completed fact worker read took 92.3 ms. No completed session worker read was reported before cancellation. The whole handler returned at 1533.8 ms with five lexical facts and one session and both lanes marked partial/deadline-or-cancelled. Its baseline took 5356.5 ms, including 5146.2 ms in exact fact SQL. This outlier is evidence that a 1500 ms core budget is cooperative, not a hard full-handler SLO or immunity from gateway tail latency.

Candidate coverage was complete except the one scoped request and all 30 deliberately injected outages. Outage lexical records match the baseline exactly. The baseline predates coverage metadata: all 246 baseline responses lack it, so its reported zero `incompleteResponses` is not evidence of completeness. It instead declares semantic unavailability on 15 scoped requests and all 30 outage requests. The candidate may omit the redundant top-level `modeUnavailable` display field under packing pressure; its mandatory coverage reasons remain.

| Cohort | Embedding attempts baseline → candidate | Failures baseline → candidate | Embedding p95 baseline → candidate ms | Main SQL max baseline → candidate ms | Candidate worker SQL p95 / max ms |
|---|---:|---:|---:|---:|---:|
| Default broad | 30 → 30 | 0 → 0 | 132.5 → 125.1 | 74.7 → 71.3 | 80.8 / 81.7 |
| Hybrid both | 60 → 30 | 0 → 0 | 121.4 → 154.6 | 81.1 → 67.9 | 123.1 / 140.9 |
| Hybrid scoped | 60 → 30 | 15 → 0 | 159.8 → 160.8 | 5360.8 → 102.9 | 387.0 / 394.5 |
| Cold connection | 12 → 6 | 0 → 0 | 185.6 → 103.9 | 88.9 → 70.0 | 120.9 / 120.9 |
| Injected outage | 60 → 30 | 60 → 30 | 0.0 → 0.0 | 79.1 → 70.8 | — |
| Four concurrent | 240 → 120 | 0 → 0 | 649.7 → 249.8 | 102.4 → 73.7 | 130.0 / 145.6 |

These are attempt counts, not token or monetary costs. Injected-outage attempts never call the real provider. Warmup calls are excluded from the reported measurement counts, so these are not total benchmark billing counts. Embedding usage and consumer tokens remain null; supported-answer accuracy is also null because no adjudication/generative calls or heldout labels were used. Real live embedding latency is shown separately above; deterministic vector/oracle tests establish storage parity without conflating those checks with network latency. Completed worker SQL timings exclude cancelled native reads that outlive request settlement.

The default workload fails the proposed 20% p95 improvement gate (3.4% observed improvement, with prior runs showing regressions). Loaded p95 also falls short (17.9%). Explicit broad hybrid improves 22.5% on this repeated query with identical returned evidence, but that is a workload-specific diagnostic, not permission for a broad speed promotion. Scoped p95 improves strongly after the verified exact join-order correction, but the one partial response prevents an equal-quality speed claim for that cohort. Cold connection n=6 is explicitly a limited diagnostic approved by the controller, not a performance promotion or a claim that OS/provider caches were flushed. No performance policy/default/provider endpoint was tuned.

Final cross-module compatibility checks after packing changes:

```sh
NLM_PG_TEST_URL=postgresql://nlm_test:nlm_test@127.0.0.1:54329/nlm_test npx vitest run tests/unit/core/context/recall-context.test.ts tests/integration/mcp-recall-logging.test.ts tests/unit/core/mcp-cite-session-attribution.test.ts tests/unit/core/mcp-no-ambient-attribution.test.ts tests/integration/mcp.test.ts tests/unit/hook/deadline-invariant.test.ts tests/integration/tenant-guard.test.ts tests/integration/scoped-semantic-recall.pg.test.ts --test-timeout=20000
npm run typecheck
git diff --cached --check
```

All 59 tests passed (eight files), including Postgres and tenant guards; all three TypeScript projects and staged whitespace checks passed. The server build passed on the final runtime source before replay. The already-recorded 85 service/context tests, 36 packing/deadline/worker tests, and direct/worker SQLite oracle checks cover the other changed paths. Tests use local stubs/fake time, not network calls. The preexisting supersedence-log cleanup warnings remained visible.

Self-review inspected the staged explicit-file diff, cancellation/lifecycle ownership, tenant identity, exact SQL parity, shared embedding identity, partial scoring, unchanged default policy, full-record selectors, report accounting and cleanup. The benchmark processes exited and their disposable database clones/code archives were removed; the original snapshot and preexisting Postgres container were left intact. No `.agent-quality.yml` gate is configured. Independent controller review remains pending.

## Changed files and commit boundary

- Core orchestration/budgets: `src/core/context/recall-context.ts`, `src/core/recall/request-budget.ts`, `execution-options.ts`, both recall services, and `context-bundle.ts`.
- Typed SQL/lifecycle: semantic reader/worker and fact/session SQL function modules, both SQLite stores, `sqlite-storage.ts`, and both storage ports' optional execution signal.
- Transport/attribution: `src/mcp/server.ts`; removed orphaned ambient scanner and replaced its tests with no-ambient attribution coverage.
- Verification: deterministic context/deadline/worker tests, scoped semantic oracle exercised through worker, existing MCP logging/citation tests, and embedding abort-count stub support.
- Evidence/docs: `scripts/eval/request-budget-performance.ts`, `docs/context-retrieval.md`, and this report. All corpus, response, and benchmark artifacts remain outside git.

Implementation commit: `3517a12e155760e177b88d0b7c8038f9fd9abf08` (`Work-Id: T806`). This subsequent documentation-only commit records that immutable implementation boundary. Remaining concerns: default speed gate not met; one real scoped deadline partial; native SQLite termination and other main-thread reads remain cooperative; attribution availability intentionally decreases without trusted transport context; cold diagnostic has six pairs; supported-answer/token-cost metrics are unavailable. Controller independent review remains pending; this implementer did not launch a reviewer or subagent.


## Independent review correction — round 1, F1

The controller's independent review (`/private/tmp/T806-task-5-review.md`) found one verified P2: the production stdio MCP composition root did not call `storage.close()` on client EOF or transport/server closure. Idle referenced semantic workers therefore kept the child alive after a successful recall. The original pool-close tests covered the pool but missed this production owner. Initial engineering/spec review failed on F1; security passed within scope. This implementer has addressed F1 below; controller re-review remains pending.

Fix base: `2cf628a9cbb28446dd773fc0705c96f2d3d5c664`. Runtime ownership changed only in `src/cli/nlm.ts`. The exported `runMcpStdio` is the actual production `mcp` command owner, and the isolated fixture calls that same function. It registers stdin EOF/close/error and SIGINT/SIGTERM handling, observes SDK server closure (including transport closure), pauses input, closes MCP to abort its active request controllers, then awaits owned storage cleanup. One shared shutdown promise prevents duplicate storage closes during recursive SDK closure or repeated signals. Cleanup removes its listeners and restores a preexisting SDK close callback. Creation/connect failures follow the same `finally` cleanup. Event callbacks notify the owner; the owner awaits the shutdown promise and propagates cleanup failures. No workers were unrefed. HTTP storage ownership and the existing realpath-based CLI entry guard are unchanged.

Files in this fix round:

- `src/cli/nlm.ts`: stdio lifecycle owner and production wiring.
- `tests/fixtures/mcp-stdio-child.mjs`: isolated actual SDK/storage/service child, deterministic embedding stub, worker-read/close/listener accounting, explicit close/startup scenarios; supports source and compiled stack imports.
- `tests/integration/mcp-stdio-lifecycle.test.ts`: six child scenarios (EOF, server close, transport close, repeated SIGTERM/SIGINT/close events, server creation failure, transport connect failure).
- This report: review finding, TDD, measurements boundary and fix handoff.

The new tests first ran against an extracted production owner retaining the prior connect-only behavior:

```sh
npx vitest run tests/integration/mcp-stdio-lifecycle.test.ts
```

RED: all six failed. The four successful worker-backed recall children did not exit within three seconds after the requested closure, and both startup failures reported zero storage closes. RED output is retained at `/private/tmp/T806-task5-stdio-red.log`. Hung RED children were explicitly killed/reaped in test cleanup. In GREEN, no parent kill is used: all children exit with code 0 and signal null, close storage exactly once, and return owner listener counts to their original baseline. Each of the four recall scenarios completes two actual worker-backed reads with a successful complete hybrid response before shutdown; the two startup-failure scenarios start no recall. The fixture originally asserted zero total stdin listeners and exposed Node's preexisting end listener; it now measures only the owner-added listener delta. A TypeScript exact-optional-property error while restoring an absent SDK callback was fixed by deleting the optional callback when none preceded the owner.

GREEN covering commands/results:

```sh
npx vitest run tests/integration/mcp-stdio-lifecycle.test.ts tests/unit/core/storage/sqlite-semantic-reader.test.ts tests/integration/context-deadline.test.ts tests/integration/cli-work-digest.test.ts
npm run typecheck
npm run build:server
NLM_STDIO_TEST_COMPILED=1 npx vitest run tests/integration/mcp-stdio-lifecycle.test.ts
```

The source covering run passed 22 tests in four files. Typechecks passed for source/tests/scripts; server build passed. The compiled production-stack child replay passed all six scenarios. A separate isolated Python `subprocess.run([node, entry, "--help"], timeout=10, check=True)` smoke used both `dist/cli/nlm.js` and a temporary symlink to it; both exited 0 with identical help output. Temporary child databases, HOME/XDG/state directories and the symlink were removed; all child processes were reaped. No live provider, installed configuration or real corpus was used.

`git diff 2cf628a -- src/core src/mcp src/ports` is empty; the sole runtime file changed is the stdio CLI composition root. Full performance replay was intentionally not repeated per the controller's ruling: the existing benchmark does not execute that CLI owner. Its run-4 fingerprint remains the measured pre-teardown-fix source fingerprint, not a claim that the new whole-source hash was benchmarked. Request implementation, all four historical reports, the retained scoped deadline failure and the no-broad-speed-promotion conclusion are unchanged.

F1 implementation commit: `f6fe2b8bb1f678c91d9ba2cc3d2b8414aa2d01ce` (`Work-Id: T806`). F1 re-review remains pending.
