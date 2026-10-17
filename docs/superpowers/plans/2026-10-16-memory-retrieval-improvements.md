# Measurable Memory Retrieval Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver better-scoped, sufficiently supported memory answers with measured total token/latency savings and no hidden correctness regression.

**Architecture:** Preserve NLM's ports/adapters and existing classifier output. Resolve tenant/workstream eligibility before ranking, prove exact-value completeness in storage, and compose bounded evidence under one request budget. Reuse the existing frozen-corpus evaluator components; optional ranking/delta/model features require their own promotion evidence.

**Tech Stack:** TypeScript/Node ESM, Zod/MCP, SQLite/better-sqlite3/sqlite-vec, Postgres/pgvector, Vitest; configured LiteLLM model roles only where the spec permits.

**Spec:** `docs/superpowers/specs/2026-10-16-memory-retrieval-improvements.md` (binding authority; section 5 owns numeric experiment thresholds).

**Status:** T806 implementation and independent review are complete from local main `a9f0729` (retrieval baseline `e391597`); planning task T805. Required Tasks 1–6 have passed independent engineering/spec/security review, including scoped fix reviews. Tasks 7–9 ended inconclusive/no-go after independent review; final integration and independent whole-branch engineering/spec/security review passed; installed deployment remains pending. The source-audited set has 120 frozen cases (65 development / 55 final holdout; 36 sources, 10 families). Exact consumer tokens and scientific promotion remain unavailable. T527/T679 are related work, not duplicate tickets.

## Global Constraints

- Tenant comes from the authenticated transport, never tool input. Every new read and join uses that tenant.
- Unspecified workstream means all accessible workstreams; an explicit unknown/foreign value returns the same empty-scope result, never an unscoped fallback.
- No new query-time generative calls in the required path. Ingestion reuses the classifier's existing output.
- Return complete evidence records within the existing 2,000–20,000 character transport guard.
- Exact-value fast path requires a complete SQL probe, not uniqueness among the first 12 or 500 candidates.
- Default compact-context budget is 1,500 ms; optional timeoutMs range 100–5,000. Deadline/cancellation is cooperative in the main-thread SQLite adapter.
- A literal anchor verifies a quote's location, not the claim's truth or the user's acceptance. Offsets are UTF-16 into the exact persisted body.
- No stored facts are retired/reinterpreted automatically; predicate-class ingest policy is unchanged.
- Schema additions are nullable, additive and implemented in SQLite and Postgres. Resolve next unused versions at execution; do not edit SQLite 042 or PG038.
- Holdout stays sealed through Tasks 1–9. Development selects candidates; Task 10 evaluates a preregistered arm family once at a fixed sample size. No sequential holdout tuning or composition selection.
- A low-powered, unavailable or failed measurement is inconclusive, never a pass. Spec section 5 contains proposed acceptance thresholds, not promised gains.

## Review Focus

1. A non-default tenant requests a label also used by the default tenant: resolution, results, quotes and telemetry stay within the authenticated tenant. Tests: Tasks 2/3.
2. Hundreds of copies of one value precede an older alternative: exact lookup reports complete multiplicity and never takes a false unique fast path. Tests: Task 4.
3. A lane hangs, rejects or finishes just after cancellation: completed evidence survives, listeners/work are cleaned up, partial state is honest. Tests: Task 5.
4. A quote repeats or contains emoji and its source is later capped/reprocessed: only exact, current persisted-body offsets are verified. Tests: Task 6.
5. A caller supplies seen evidence after compaction, query/scope change or rebinding: required context returns, and foreign references do not reveal existence. Tests: Task 8.

## File and interface ownership

| Unit | Existing code to reuse/modify | New focused files |
| --- | --- | --- |
| Evaluation | `src/core/eval/harness/{snapshot,goldens,metrics}.ts`, `run-eval.ts`, `scripts/eval/context-retrieval.ts` | `src/core/eval/context/{types,score,run}.ts`, `scripts/eval/memory-context.ts` |
| Scope | `src/ports/{session-store,fact-store}.ts`, `src/shared/types.ts`, `src/cli/nlm.ts`, `src/mcp/server.ts`, both recall services and DB adapters | `src/core/recall/{resolve-scope,execution-options}.ts` |
| Conflict proof | FactStore and both fact adapters; compact-context handler/builder | Focused aggregate helpers only if the existing adapters need them |
| Request execution | Both recall services, MCP handler, `LLMClient.embed` signal support | `src/core/context/recall-context.ts` orchestrator, `src/core/recall/request-budget.ts` |
| Source anchors | `extract-facts.ts`, scheduler, webhook ingest, both session/fact adapters, `src/ports/llm-client.ts`/`src/shared/types.ts` | `src/core/context/source-version.ts`, `src/core/facts/source-anchor.ts`, additive migrations |
| Optional delta | Context builder/handler and response schema | `src/core/context/evidence-reference.ts` |
| Optional reranker | Existing LLM complete/role wiring; context selection | `src/core/context/rerank-evidence.ts` and evaluation adapter |

Names/signatures below are proposed new contracts. Baseline symbols above exist; recheck them at execution preflight. Do not create a parallel fact store, resolver or evaluator where a small extension fits.

## SDD execution and review contract

- Read the spec and plan once. Resolve the plan-specific workspace with the installed SDD `scripts/sdd-workspace`; first ledger line identifies this exact plan. Resume from ledger plus git, not conversation recollection.
- Before Task 1 code, write one preflight row per task and per shared-file/interface pair. Resolve conflicts against the spec; record rulings, costs if wrong, and scope changes. This is required even if the scan is clean.
- One implementation worker at a time: Tasks 2–6 share adapters/types; parallel writers would add merge/review cost. Workers are not alone in the repo, must preserve others' changes, and do not spawn helpers/reviewers.
- Dispatch task-scoped briefs/reports by file path, with no full chat/history and no repeated earlier-task summaries. Record BASE before dispatch; review the complete BASE..HEAD range, not HEAD~1.
- Name the model explicitly: cheapest suitable lane for mechanical changes; standard lane for multi-file adapters; strongest configured review lane for concurrency/security/final review. Resolve current lane identities from workspace configuration, not stale model names in this plan.
- One fresh task reviewer covers both spec compliance and code quality; this is the workspace code-review gate, not an additional duplicate seat. Use the configured Muse Spark 1.3 xhigh review lane/fallback policy and the SDD task-reviewer rubric. Persist separate spec/quality verdicts plus findings; if the launcher output lacks a verdict, explicitly reconcile the requirement checklist in the ledger before accepting it. Tenant/scope/expansion reviews include the security lens.
- Fix reviews use the fix diff and covering test evidence; do not rerun identical full suites or re-review unchanged files. Use SDD's bounded fix loop and explicit adjudication rules. No unresolved load-bearing issue is silently parked.
- Final whole-branch review is required after all enabled tasks and covering fixes. Reconcile parked findings and metric claims. Avoid launching a second identical review merely because both SDD and code-review name it.
- Per task: red test -> minimal implementation -> focused tests -> independent task review -> scoped fixes -> explicit-path commit with Work-Id. Final typecheck/build/full suite and both DB contracts are required. No configured agent-quality gate exists at the pinned baseline; record actual checks.

## Task 1: Establish the end-to-end measurement and baseline

**Dependencies:** none. **Deliverable:** repeatable baseline and frozen labels/cost contract before optimization.

**Files:** Create `src/core/eval/context/{types,score,run}.ts`, `scripts/eval/memory-context.ts`, `tests/unit/core/eval/context-score.test.ts`, `tests/integration/memory-context-eval.test.ts`. Reuse existing snapshot/golden/run-eval utilities; modify `docs/eval-harness.md`. Private dataset/reports live under `~/.nlm/eval/`, synthetic cases in `tests/fixtures/`.

**Interfaces:**
- `ContextCase {id; question; workstream?; category; sourceFamily; split; expected:{answerable; claims; alternatives; sourceRanges}}` (types, not free-form judge scores).
- `MemoryContextReport {manifest; perCase; strata; tokenTotals; latency; failures; confidenceIntervals; promotion}`.
- `runMemoryContextEval(input: {manifestPath:string; baseline:string; candidate:string; outputPath:string}, deps: EvalDeps): Promise<MemoryContextReport>`.
- `TokenCounter.count(text:string):number`, plus immutable tokenizer/model revision metadata; unavailable counters are explicit nulls in reports. `EvidenceReader` receives question plus bundle only; labels/original sources never enter that reader's input.

- [x] Write scoring tests proving that a correct value without its required rationale/source fails a rationale case; missing one alternative fails ambiguity; unrelated text fails no-answer; ten duplicated cases do not create ten independent bootstrap groups.
- [x] Run `npx vitest run tests/unit/core/eval/context-score.test.ts`; confirm the new assertions fail before implementation.
- [x] Implement the scorer/orchestrator and CLI. Reuse snapshots/scoring pieces, not the broad harness's unrelated quadratic re-derivation scan. Run pinned baseline/candidate commits in isolated executor-owned worktrees; do not mutate production or fake the baseline by globally monkeypatching current code. Sample CLI contract: `npx tsx scripts/eval/memory-context.ts --manifest <private-manifest> --baseline e391597 --candidate <sha> --out <private-report>`.
- [x] Build and freeze the spec's >=120 source-checked question set, family-disjoint split, adversarial matrix, tokenizer/reader/model/prompt manifest and proposed thresholds before tuning. Independently audit source labels; document shortages/inconclusive strata. Character diagnostics remain separate from actual token totals.
- [x] Run the synthetic integration suite and a baseline-vs-identical-baseline replay: identical deterministic evidence scores, identical token counts with fixed tokenizer, every costed call represented. Live latency records embedder/cache/load conditions. Check model usage cannot disappear when a stage fails.
- [x] Obtain the task review, record baseline artifacts/hashes/aggregate numbers and accepted/rejected findings, then commit evaluator and documentation only. No optimization result is claimed yet.

**Control evidence:** The frozen 65-development-case replay against identical pinned baseline commits returned identical literal-evidence scores/reader answers (7/65) and zero execution failures. Consumer-token totals remain null because the exact tokenizer is unavailable; no natural-answer-quality or latency promotion follows from this control.

## Task 2: Resolve and propagate tenant-owned workstream scope

**Dependencies:** Task 1. **Deliverable:** one scope contract across compact/legacy recall and expansion.

**Files:** Create `src/core/recall/resolve-scope.ts`, `execution-options.ts`; modify `src/ports/{fact-store,session-store}.ts`, `src/shared/types.ts`, `src/core/recall/recall-service.ts`, `src/core/recall-facts/fact-recall-service.ts`, `src/core/storage/{sqlite,pg}-{session,fact}-store.ts`, `src/cli/nlm.ts`, `src/mcp/server.ts`; extend `tests/integration/recall-workstream-filter.test.ts`, `mcp-context.test.ts`, tenant tests, and the shared fact-store contract.

**Interfaces:** Produces `ResolvedRecallScope` and `resolveRecallScope(...)` exactly as spec section 4. `RecallExecutionOptions` initially has `workstreamIds?:readonly string[]`. Both `search(tenantId,input,options?)` methods consume it. `FactEligibility` contains the eligibility fields in the spec; FactListFilter adds query/limit. Public context/expansion schemas add `workstream?:string` only.

- [x] Add failing contracts for duplicate labels in two tenants, merged workstreams, explicit unknown/foreign selector, missing binding, cyclic merge chain and rebind between retrieval/expansion. Assert correct IDs and zero out-of-scope values/quotes; never assert only result count.
- [x] Run the relevant workstream/tenant/context tests and confirm new scope cases fail on the baseline.
- [x] Implement the shared resolver and replace the DEFAULT_TEAM_ID closure with `(tenantId,idOrLabel)` resolution. Apply source-session workstream joins to lexical facts before LIMIT and preserve undefined-vs-empty eligibility. Pass requested scope through session/fact retrieval, telemetry and all emitted expansion arguments; recheck tenant and current membership on expansion, including scoped fact history.
- [x] Run `npx vitest run tests/integration/recall-workstream-filter.test.ts tests/integration/mcp-context.test.ts tests/integration/tenant-leak-contract.test.ts tests/integration/tenant-leak-contract.pg.test.ts tests/integration/sqlite-fact-store.test.ts tests/integration/fact-store.pg.test.ts`. Require both adapters to run (a skipped PG lane is not parity evidence).
- [x] Replay scoped cases and measure irrelevant evidence/token share. Report capability failures separately from ranking failures; the baseline did not support the new selector, but both readers receive the same natural-language project question.
- [x] Security/spec/quality review the task as one diff, fix findings, commit. Do not claim semantic starvation fixed until Task 3 passes its oracle.

## Task 3: Retrieve eligible semantic neighbors without global-window starvation

**Dependencies:** Task 2. **Deliverable:** scoped semantic top-k matches an eligible-corpus oracle.

**Files:** Modify the four DB adapters, FactStore semanticSearch signature, both recall services; create `tests/integration/scoped-semantic-recall.test.ts`, `scoped-semantic-recall.pg.test.ts`; extend store contracts and private performance replay.

**Interfaces:** `FactStore.semanticSearch(tenantId:string, vector:Float32Array, limit:number, eligibility?:FactEligibility):Promise<readonly FactSemanticNeighbor[]>`. Session semanticSearch retains SearchOptions. Services pass full eligibility before candidate limits. ChunkIndex survives per-session max pooling.

- [x] Add a failing fixture with more than the current global overfetch window of wrong-tenant/wrong-workstream/retired/low-confidence near neighbors ahead of the correct eligible one; include many chunks from one session and a missing chunk-map row. Assert eligible IDs, winning chunk and distances, not non-empty output alone.
- [x] Run new cases on SQLite and Postgres; demonstrate the fixed-window failure before changing the query.
- [x] Implement eligible exact-distance selection in SQLite using the installed extension's verified `vec_distance_L2` capability; join tenant-owned source sessions and filter metadata before top-k/grouping. Use embedding row metadata rather than making chunk-map completeness a prerequisite. Postgres filters the same eligible set before ranking/limit. Preserve deterministic ties. An approximate alternative requires explicit incomplete coverage and separate evidence; it cannot silently replace the oracle path.
- [x] Compare each adapter against a brute-force eligible-vector oracle (distance tolerance 1e-5), including empty scopes and no embeddings. Run the new tests and existing semantic/tenant contracts.
- [x] Replay real scoped workloads with eligible-vector counts and SQL time. Apply the spec's scoped-evidence gate; flag large synchronous scans for Task 5's responsiveness check. API availability from the planning probe is not performance certification.
- [x] Obtain security/spec/quality review, resolve findings, commit the parity result and aggregate measurements. Coordinate T679; leave unrelated hook behavior unchanged.

**Execution evidence:** Engineering correctness passed exact-distance, tie, cap-fallback and tenant/scope oracles. SQL-only private diagnostics found steady unscoped session reads around 83–112 ms, first-use 1,123 ms (a previous contended run reached 2,698 ms), scoped session p50/p95 334/440 ms, and exact full-scan fallback around 1.9 s. These are not whole-request or cold-OS results. Natural-query quality and speed promotion remain unproven; Task 5 owns responsiveness.

## Task 4: Prove exact lookup uniqueness across all eligible values

**Dependencies:** Task 2 (execute after Task 3 to serialize shared adapter ownership). **Deliverable:** complete current-value summary and safe fast path.

**Files:** Modify `src/ports/fact-store.ts`, both fact adapters, context handler/builder; extend shared fact-store contract, `mcp-context.test.ts`; create `tests/integration/current-value-summary.test.ts` for transaction/timeout behavior where needed.

**Interfaces:** Produces `summarizeCurrentValues(tenantId, query:CurrentValueQuery):Promise<CurrentValueSummary>` and response `lookup:{distinctValueCount:number|null; complete:boolean}` from spec section 4. Use exact JSON tuple keys for subject/predicate grouping. Legacy candidate-only multipleValues must not become a claim about the full corpus.

- [x] Add failing tests: 600 newer copies of A plus older B -> count 2; identical A copies -> count 1 with correct distinct-source count; scoped-out/retired/superseded/low-confidence B -> count 1; multiple legitimate facets remain multiple; interrupted probe -> complete=false and no unique fast path.
- [x] Run the shared SQLite/PG contracts and context tests; record which baseline assertions fail.
- [x] Implement one consistent aggregate query/snapshot before preview limits, with at most two complete example values. Reuse existing covering indexes where applicable. Wire the full probe into explicit exact lookup; one distinct eligible value skips the session lane, multiple/unknown values preserve ambiguity and scoped expansion. No fact is retired or chosen merely because it is newest/repeated.
- [x] Run both adapters plus context/tenant tests; check the async logging regression still proves no phantom session search for a safe exact lookup.
- [x] Replay ambiguity/no-answer cases. Require 100% oracle agreement and zero false unique answers; measure probe SQL/response overhead against the same-quality cases.
- [x] Review query consistency, scope/lifecycle parity and result-bound behavior, fix, commit. This is a correctness gate even if a speed target remains inconclusive.

**Execution evidence:** Both adapters passed full distinct-value/source-count oracles, including hidden alternatives beyond 600 repeated values and actual PG interruption. The private synthetic diagnostic covered 20 case/backend combinations with 1,200 repeated checks, zero false unique results. Timing excluded the preexisting ambient transcript attribution scan and does not establish request latency. Review found and fixed long/escaped lookup-selector corruption; actual handler tests replay returned history arguments to recover omitted evidence. No answer-quality or token gain is claimed.

## Task 5: Compose retrieval lanes under one request budget

**Dependencies:** Tasks 1–4. **Deliverable:** parallel broad lookup, safe exact fast path, honest partial responses and cleaned-up cancellation.

**Files:** Create `src/core/context/recall-context.ts`, `src/core/recall/request-budget.ts`; move orchestration out of the large MCP handler without changing its default evidence policy. Modify execution-options, both recall services, MCP schema and tests; create `tests/unit/core/context/recall-context.test.ts`, `tests/integration/context-deadline.test.ts`. Extend LLM stubs rather than adding network-dependent unit tests.

**Interfaces:** `RecallExecutionOptions` gains signal/deadlineAt/request-local queryEmbedding per spec. `recallContext(tenantId:string,input:ContextRequest,deps:ContextDeps):Promise<ContextResult>` is transport-independent; the MCP adapter validates input and formats the result. `ContextRequest.timeoutMs` defaults to 1500, min 100/max 5000; a fake monotonic clock is injectable. ContextResult carries coverage/lookup separately.

- [x] Add deterministic delayed-lane tests: two 100-ms independent lanes overlap rather than sum; a unique exact lookup launches no session search/embedding; one lane failure retains the other; already-aborted request launches zero outbound calls; hanging provider observes abort; late completion cannot change a returned response; no listeners/timers remain. Use fake time for assertions, not timing-sensitive unit sleeps.
- [x] Run the focused unit/integration tests and confirm red cases before orchestration changes.
- [x] Implement shared remaining-budget propagation, request-local embedding sharing only when query/kind/embedder identity match, parallel non-exact lanes and lexical fallback preservation. Compose with the existing session/hook embedding deadline; do not stack independent full budgets. Mark partial/unavailable lanes explicitly. Validate once at transport; keep error handling at boundaries.
- [x] Exercise cancellation/error paths and existing MCP logging/deadline tests. Demonstrate one shared embedding call for explicit hybrid-both mode and no stale promise reuse across requests/models.
- [x] Run >=30 paired requests per real selected workload after 5 warmups, reverse arm order, and separate cold/outage/loaded strata. Require >=20% p95 end-to-end gain without supported-evidence loss for the speed claim. Measure synchronous SQL segments. If they violate the gate, implement a bounded read-only worker for the identified typed read before promotion, with pool/shutdown tests; do not claim timers preempt synchronous SQLite. If this cannot meet the gate, record the limitation and withhold the speed claim.
- [x] Obtain the concurrency/security/spec/quality review, fix, commit the actual performance outcome. Do not broaden into an unrelated daemon worker rewrite.

**Execution evidence:** Implemented in `3517a12`/`2cf628a`; independently reviewed production stdio teardown fix in `f6fe2b8`/`6ae95c7`. Coverage, partial lexical evidence, exact embedding identity, bounded read-only worker queue and shutdown passed deterministic contracts; actual child processes now exit normally after worker-backed calls and EOF. SQLite source-first exact fact joins corrected a measured planner regression without editing migration 042.

The final isolated paired diagnostic used the actual prior handler `69f4c3f`, matching disposable snapshots and empty transcript roots. Thirty pairs after five warmups per steady workload: p95 default 323.2→312.3 ms, explicit hybrid 496.0→384.2 ms, scoped hybrid 5,966.4→635.6 ms. Loaded p95 1,254.5→1,030.2 ms; injected outage 90.2→93.0 ms. Cold-connection n=6 is diagnostic only. Complete evidence records matched for 245/246 paired responses; one scoped response returned partial evidence at 1,533.8 ms after a slow embedding. That loss remains counted and blocks scoped/every-workload speed promotion. Default speed improvement is below the proposed 20% threshold; no supported-answer/token promotion is claimed. The CLI-only teardown fix does not execute in the benchmark; measured runtime fingerprint is the pre-fix `b735f3de303279022671a65523a83582b984ad4c3797e27a6215b191a4326ce8`. All four private runs remain retained, including regressions.

## Task 6: Verify and version literal fact source anchors at ingestion

**Dependencies:** Tasks 1–5. **Deliverable:** trustworthy literal locations without new classifier calls or destructive backfill.

**Files:** Create `src/core/context/source-version.ts`, `src/core/facts/source-anchor.ts`; modify `src/shared/types.ts`, `src/core/facts/extract-facts.ts`, `src/core/scheduler/scheduler.ts`, `src/core/ingest/ingest-session.ts`, both session/fact adapters, store contracts and source expansion. Add next-unused SQLite/PG migrations and update the tenant table/schema census/assertions if needed. Create `tests/unit/core/facts/source-anchor.test.ts`, `tests/integration/fact-source-anchor.test.ts`, `fact-source-anchor.pg.test.ts`.

**Interfaces:** `bodyVersion(body:string):string` uses the existing 16-hex SHA-256 contract. `locateSourceAnchor(body:string, quote:string|undefined):SourceAnchor` returns the verified/unverified union from the spec. `ExtractFactsOptions` gains `sourceBody?:string`; verified offsets are computed only when the exact persisted body is available. Fact gains optional sourceAnchor. Storage persists session body_version and nullable fact anchor columns atomically.

- [x] Add failing tests for a unique literal, absent quote, repeated quote, emoji/combining text before the quote, classifier input longer than the persisted cap, unchanged-body reingest, changed-body invalidation, legacy null fields and rollback on fact-write failure. Assert both exact slice equality and source version, not confidence alone.
- [x] Run unit and both adapter tests, recording baseline failures.
- [x] Implement pure location/version helpers and wire every session/fact write path (scheduler, webhook, reprocess and seed helpers). Pass record.body after normalization/capping; never raw input.text. Extract once from existing classifier output. Nullable migrations must not hash the whole corpus at startup. Include explicit source-anchor column lists in all fact row projections that return anchors.
- [x] Validate anchors against current session version on read/expansion. Recheck tenant/workstream; old/missing versions stay unverified. Keep on-demand verification read-only/ephemeral; persist legacy anchors only through an explicitly requested bounded maintenance/reprocess path. Do not add hidden writes to readOnly MCP tools.
- [x] Run migration idempotence, UTF-16/SQLite code-point conversion parity, source-integrity and transport tests. Benchmark quoted-fact verification CPU separately from DB I/O; the proposed >=50% CPU reduction is not a claim of lower whole-request latency. Defer range-read optimization if it cannot preserve UTF-16 parity; report whether full bodies are still read.
- [x] Independent review covers stored-vs-classifier-body confusion, all ingest entrypoints, atomicity and stale anchors. Fix, commit. No schema change is deployed as part of the planning session.

**Execution evidence:** `ce784f9`/`c40fa30` passed independent engineering/spec/security review, with one deferred duplicate-hydration advisory. Nullable SQLite 043 / PG039, legacy-writer invalidation, FTS integrity, all write/read projections, atomic rollback, persisted UTF-8/UTF-16 parity and bounded legacy quote verification passed 267 focused tests plus final 26 adapter assertions, typecheck and server build. No deployment/backfill occurred. Expansion still reads full bodies and slices in JavaScript.

A deterministic 256-of-9,977 quoted-fact sample contained 95 unique literals, 142 absent quotes and 19 ambiguous quotes; all sampled sources had legacy null versions. Actual legacy CPU increased 18.08% versus the weaker presence-only check: the proposed 50% overall reduction **failed**. Counterfactual current new-write assessments reduced verification CPU 99.08% (unique positives 97.41%); these exclude preparation and I/O and do not establish present-corpus gains. Missing/stale stored assessments stay unverified, with fresh unique-literal proof allowed ephemerally and without writes. The reviewer found possible repeat body reads between partial/final publications; final review must triage this advisory.

## Task 7: Re-evaluate corroboration ranking under T527

**Dependencies:** Tasks 1–6. **Deliverable:** evidence-backed ranking decision; keeping the current policy is a valid outcome.

**Files:** Modify `src/core/recall-facts/fact-recall-service.ts` to inject a pure ranking policy for evaluator arms, keeping production default stable until promotion. Extend `tests/unit/core/recall-facts/fact-corroboration.test.ts`; add experiment support to `scripts/eval/memory-context.ts`; document aggregate findings in `docs/`.

**Interfaces:** `CorroborationPolicy = (count:number)=>number` for factor experiments, plus an explicit relevance-first tie-break policy if evaluated. Store count semantics stay unchanged. No process-global env mutation while concurrent arms run.

- [x] Add tests proving that disabled boost retains count metadata; count cannot promote a zero-relevance non-match; equal triples from copies are distinguished from independent evidence in reports; multiple facets are not retired.
- [x] Verify tests on current policy, then freeze the three-arm grid (cap 2.0, cap 1.0, relevance-first/tie-only) on development data before holdout.
- [x] Run paired identical-vector experiments against the post-correctness baseline. Evaluate supported answers/evidence and no-answer behavior as primary metrics; retain R@1/R@5/MRR as diagnostics.
- [x] Select at most one candidate using development data and the spec's proposed quality gates. Register it for Task 10; keep holdout sealed and production ranking unchanged. Estimate final sample size from development data, not intermediate held-out results.
- [x] Review scoring methodology as well as code; verify any apparent gain against original sources and audit disagreements. Record rejected/accepted findings.
- [x] Commit the development report and a disabled candidate only; Task 10 owns held-out promotion. Update T527 with evidence; do not create a duplicate ranking task or claim a failed experiment as a feature.

**Execution evidence:** `78342db`/`ed58dc5` passed independent code/spec/security and methodology review, with 37 focused tests and typecheck. The preregistered 3-policy × 2-session-mode development grid produced literal-evidence counts 10/65 for current cap2/default, 11/65 for cap1/default and tie-only/default, and 2/65 for every both-hybrid arm. The best +1.54 pp is below the frozen overall +5 pp threshold. No primary blinded answer-quality or power estimate is available, so no optional arm qualifies for Task 10. Production remains unchanged.

The control matches 65/65 scores but only 64/65 reader answers/full bundles: a first-request partial baseline differs while both versions score insufficient. All baseline deadline failures remain counted; no reruns were used to remove them. Source audits validated 71/71 gold UTF-16 ranges and audited all disagreements/no-answer errors plus seeded agreements. All 328 nonliteral occurrences were historical `sourceQuote` fields explicitly marked `quoteVerified:false`; none was a verified-quote contradiction. Seven hybrid losses omit the intended source from the packed bundle; one retains its source but omits the needed range. These are scoped engineering followups for T527, not a general claim about hybrid retrieval. [Development report](../../memory-corroboration-experiment.md).

## Task 8: Test caller-declared evidence deltas for repeated context

**Dependencies:** Tasks 1–7. **Deliverable:** optional delta responses only if they reduce total chain tokens without losing needed context.

**Files:** Create `src/core/context/evidence-reference.ts`, `tests/unit/core/context/evidence-reference.test.ts`, `tests/integration/context-delta.test.ts`; modify context builder/orchestrator and MCP schema; add repeated-conversation replay to the evaluator.

**Interfaces:** `EvidenceRef {id:string; version:string}`; optional `seen:readonly EvidenceRef[]` input (max 64 entries). `renderedEvidenceVersion(input:{fullQuery; resolvedScope; intent; policyRevision; evidence}):string`. Response returns fresh coverage/lookup/omission metadata plus changed/new records and unavailable references; absence of seen returns the full compact bundle.

- [ ] Add failing tests: identical record/query can be omitted; changed source/query/budget-selected evidence/scope/policy returns needed context; compaction reset returns full records; retirement and rebinding invalidate; foreign/nonexistent IDs produce identical unavailable behavior. Include changed confidence/decision state even when the body text is unchanged.
- [ ] Replay repeated-context development traces to estimate the achievable saving before adding persistent state. If repetition does not support the spec's >=20% total-chain token target, stop this experiment and record no-go.
- [ ] Implement caller-controlled references with no server-global conversation cache, no implicit seen state and no authority granted by a reference. Recompute eligibility before deciding omission. Limit/validate seen entries at the MCP boundary.
- [ ] Run all invalidation/compaction/tenant tests and independent-reader replay, including refetch calls and schema/reference overhead in the token total. Do not count suppressed tokens that the reader must immediately retrieve again as a net saving.
- [ ] Register a candidate only after development meets the spec's token and quality gates; Task 10 owns held-out promotion. Keep it disabled meanwhile; default behavior remains full compact context for clients that do not opt in. Cache/embedding-cache work remains deferred unless observed repeat rates justify a separate experiment.
- [ ] Security/spec/quality review, fix and commit a disabled development-qualified implementation or a measured no-go. State the result in the ledger so later workers do not repeatedly rebuild the same failed optimization.

**Disposition:** Completed, independently reviewed capability stop (`74afcfa`); scientific **INCONCLUSIVE / NO-GO**. Historical traces lack trusted full conversation/scope/rendering identity; actual consumer accounting and blinded quality are unavailable. No repeated-context rate or token saving was inferred. No API, state/cache, optional candidate or runtime overhead was added. The conditional implementation/test boxes above remain unchecked because those stages were not run. [Evidence-delta report](../../memory-evidence-delta-experiment.md).

## Task 9: Run a bounded decision-model reranking experiment

**Dependencies:** Tasks 1–7; independent of delta promotion. **Deliverable:** a default-off, measured advisory experiment; model availability alone is not an adoption criterion.

**Files:** Create `src/core/context/rerank-evidence.ts`, `tests/unit/core/context/rerank-evidence.test.ts`; extend evaluator and configured model-role wiring only as needed. Preflight `src/ports/llm-client.ts`, the configured completion adapter (`src/llm/deepseek-client.ts` or configured equivalent), `src/llm/classifier-box.ts` forwarding, and wrappers/fakes. Reuse the existing model client boundary; do not create direct provider endpoints or a second classifier framework. Change only the selected configured adapter; unsupported adapters cannot enable this optional stage.

**Interfaces:** `rerankEvidence(input:{query; candidates; deadlineAt},deps:RerankDeps):Promise<{orderedIds:readonly string[]; abstained:boolean; usage:ModelUsage; status}>`. Output may reference only supplied IDs. Maximum 8 candidates, 3,000 measured input tokens, 256 output tokens, all within remaining request budget. Proposed optional `LLMClient.completeMeasured(...)` returns `{text, usage:{inputTokens,outputTokens}, model}` with enforced maxTokens and cancellation; preserve text-only complete callers. Usage comes from provider/gateway receipts, including cached/billed categories when supplied; a pinned tokenizer serves admission/reader counts, not proof of billed usage. Reconcile failed/timed-out calls against gateway accounting; unknown usage stays null and blocks cost-based promotion. Missing capability returns unavailable/no-go.

- [ ] First verify the configured client can expose exact usage and enforce its output cap. Baseline complete returns string; do not assume accounting exists. Write failing adapter/wrapper and reranker tests for usage propagation, provider cap parameters, abort/listener cleanup, invented IDs/quotes, malformed JSON, over-budget input/output, expired budget, failure and abstention. Assert no fact writes and baseline evidence retention.
- [ ] Freeze a development-derived ambiguity trigger, prompt, current LiteLLM decision-role model/revision and token counter. Record classifier-extraction usage separately; it is not duplicated in the hot path. Add no new model call to ordinary deterministic lookups.
- [ ] Run the experiment offline first; count triggered, skipped, timed-out and failed calls across all queries. Ensure model output can only reorder/select supplied evidence or abstain; deterministic source/version/tenant checks still govern it.
- [ ] Apply the spec's quality, tokens-per-supported-answer (<=1.10x baseline), and latency gates on development data; register a qualified candidate for Task 10 without opening holdout. Unavailable usage/cap enforcement is no-go. Audit every quality disagreement against original text; do not let a model judge certify its own invented evidence. Inconclusive/no-go leaves the advisory path off.
- [ ] Review trust boundaries, budget cleanup and the experiment's denominator with the strongest appropriate reviewer. Fix findings over the small diff.
- [ ] Commit a development report and disabled candidate only; Task 10 may wire a runtime option after independent held-out promotion. Never add an unconditional router, judge or gate to every recall request.

**Disposition:** Completed, independently reviewed capability stop (`8e92d68`); scientific **INCONCLUSIVE / NO-GO**. The current completion boundary discards usage/model receipts, has unqualified cancellation and no verified provider-cap/accounting reconciliation. Actual consumer tokens and blinded reader quality are also unavailable. No generative call, reranker, port extension, new provider or optional candidate was added. The conditional experiment/test boxes above remain unchecked because those stages were not run; 16 existing focused tests and offline fake-adapter diagnostics are not promotion evidence. External metadata observations are author-reported; independent review verified the source boundary. [Decision-model report](../../memory-decision-model-experiment.md).

## Task 10: Final integration, release decision and canary

**Dependencies:** Required Tasks 1–6 complete; Tasks 7–9 each have a frozen development-qualified candidate or no-go/inconclusive outcome. **Deliverable:** reviewed, traceable release candidate with honest before/after evidence.

**Files:** Update `docs/context-retrieval.md`, `docs/eval-harness.md`, relevant README/tool descriptions/templates and `logs/CHANGELOG/CHANGELOG.md` (10-entry cap). Regenerate hook bundles from source. Record private report hashes/aggregate results and task evidence; no raw corpus or large artifacts in git.

**Interfaces:** Final report ties each enabled change to its baseline commit, dataset/model/tokenizer manifests, source-grounded metrics, regression checks, review verdict and rollback action. Optional no-go stages add no runtime overhead.

- [x] Run SDD's cross-task interface/requirements matrix again. Include all accepted/rejected/parked findings and ensure every mandatory spec clause has an implemented, tested owner. Recheck installed-vs-landed state and capture/schema overlap tasks; stale task titles are not current integrity evidence.
- [x] Run `npm run typecheck`, `npm run build`, `npm test`, and PG-backed contracts with the test DB configured. Inspect skipped tests, generated diffs and source/version parity. Do not claim agent-quality preflight ran unless a configuration was actually adopted and executed.
- [x] Before unsealing holdout, freeze the fixed final sample size (development-only power estimate, <=240), required-only baseline, individual optional arms, combined candidate and any fallback composition/contrasts. Run that preregistered family once; use simultaneous grouped confidence bounds for the comparison family. Report all strata, failures, confidence limits, total/incremental tokens, refetches and cold/warm p50/p95. Failed combined quality gates leave optionals off unless a preregistered tested fallback passes; never build a new candidate from held-out outcomes. Reuse pinned intermediate results only when code/data/model hashes match. No failed measurement is silently replaced by an easier cohort.
- [x] Obtain one final whole-branch code/spec/security review on the configured strongest lane with the complete diff and metrics artifact, then one bounded fix wave/scoped re-review. Re-run only covering checks after fixes; run final full checks if shared interfaces changed. Record all rulings and unresolved limitations.
- [ ] Land through nxtgit, sync actual task statuses/evidence and remove owned clean worktrees. Publishing/deployment follows the authorized release scope; a plan approval alone is not an instruction to publish. Make a consistent backup and preserve the preceding compatible binary before applying additive migrations.
- [ ] Canary on the installed MCP transports: scoped tenant lookup, hidden alternative, mid-transcript/Unicode source, stale version, embedding outage and repeated-context reset. Verify emitted payloads/usage rather than health status alone. Restore the prior compatible binary on a correctness regression; never delete the corpus to roll back. Close the release work only after live evidence, or explicitly report deployment pending.

**Integration evidence:** `3d5a702`/`49dd646`/`e4f5a6a`/`00abe12` completed the mandatory test-owner matrix and one preregistered 55-case literal diagnostic. The identical-baseline development control matched 5/5 bundles/readers after frozen warmups. Literal sufficiency changed 1/55→5/55 (five-family grouped 95% interval [0,+19.35 pp]); both arms remained 0/6 on no-answer. Primary blinded quality, power and actual-token costs are unavailable, so no scientific or optional promotion follows. No execution failures; all candidate lanes reported complete. Full typecheck/build passed; 3,278 tests passed with real PostgreSQL and three explicitly opt-in live-embedder skips. Final independent EngineeringSpec/EngineeringQuality/Security review passed with Low A1 retained in T810; no code fix was required. Local landing is tracked in T806/git; installed deployment/canary are separate and pending. [Results and evidence](../../memory-retrieval-results.md) · [Rulings and costs](../../memory-retrieval-rulings.md).

## Execution handoff

Recommended: SDD with sequential implementation and one scoped reviewer per task, because the
adapter/type changes are tightly coupled. Use task briefs and the ledger to bound context;
reserve the strongest model for scope/concurrency/source integrity and final review. Plan/spec
review is separate from implementation code review. This planning task does not authorize
implementation, schema deployment or public publishing.

First execution action: create the execution work item/worktree, read the spec, resolve the
plan-scoped SDD ledger, verify base/installed versions, and perform the shared-interface preflight.
Then Task 1 establishes the measurement baseline before optimization changes.

## Planning review record (T805)

Independent source-grounded critical review checked the baseline mechanisms and implementation
contracts. Two findings were accepted and fixed: sequential holdout reuse, and an unowned
completion usage/output-cap capability. Scoped re-review confirmed both resolved with no residual
blocker in the amended clauses. The reviewer made no code changes or runtime-test claims.

Planning validation: local document links, ten ordered tasks with sixty unchecked task steps,
Drawio XML parsing and rendered visual inspection, plus `git diff --check`. Runtime code and the
installed daemon are unchanged; the implementation/review/evaluation steps above remain pending.
