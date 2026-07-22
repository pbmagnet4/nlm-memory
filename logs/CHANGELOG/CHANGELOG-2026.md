## 2026-06-24 (cont.) — #367 workstream foundation (Plan A) built, flag-gated off, merge-ready

**Changes:** Plan A of the workstream abstraction (#367), 10 TDD tasks. New `workstreams` + `workstream_entities` tables + `sessions.workstream_id/binding_source/binding_confidence` (migration 025 + pg parity). New pure core `src/core/workstream/`: `model.ts` (types + makeWorkstreamId + normalizeLabel), `resolve.ts` (merge-chain to live survivor, cycle-guarded), `match.ts` (semantic+entity blend, three-band bind/ambiguous/create), `rollup.ts` (workstream to current facts + non-retired exemplars by session binding), `bind.ts` (embed -> semanticSearch -> exclude-self -> neighbor-workstreams -> entity-overlap -> match -> create/dedup, fail-open). New `WorkstreamStore` port + sqlite/pg adapters; `SessionStore.setWorkstreamBinding/listSessionIdsByWorkstreams/getEntities/getWorkstreamIds`; batched `FactStore/CodeExemplarStore.listBySessions`. Flag-gated bind wired into the scheduler classify sweep (`NLM_WORKSTREAM_BIND`, default OFF). Locked gold-set harness (`scripts/eval/{lib/matcher-gold,tune-matcher,dump-matcher-candidates}.ts` + synthetic fixture). ~39 new tests.

**Decisions:** Live binding ships flag-OFF; shipping it on before Plan D seeds the taxonomy + tunes thresholds would make every session fall below LOW and CREATE a workstream (the "swamp" spec §17 warns of); flipped at Plan D's "Flip" step per the spec's gated rollout. `ws_<uuid>` not ulid (no dep; created_at orders). Plain Jaccard for v1 entity overlap (IDF deferred to Plan D tuning per spec §17). Matcher self-exclusion is load-bearing (insertSession already embedded the session, so it is its own nearest neighbor). Verified on the live DB that the spec's "first entity = alphabetical" root-bug claim holds (SQLite composite-PK index ordering). One review-approved scope-expansion kept: sqlite fact insert now persists `retired_at` (was silently dropped though read back), null-safe on ingest.

**State:** Branch `feat/workstream-foundation`, 16 commits ahead of main, NOT pushed (public repo, awaiting Edward). Typecheck clean; 1415 tests pass (the lone `cli-work-digest` error is the pre-existing CLI-exit flake, not a workstream regression; the bind path is flag-off and untouched by work-digest). Final whole-branch review (Opus): READY TO MERGE, no Critical/Important. Public-repo hygiene: scrubbed "PolySignal" (unreleased venture) -> "Beacon" in 3 new test files; flagged pre-existing PolySignal leak in http.test.ts + backfill-facts.pg.test.ts for separate cleanup. Merge to main is behavior-neutral (flag off).

**Next:** Plan B (recall_workstream + work-digest topic-provider swap + telemetry seam), Plan C (lifecycle rebind/merge/rename via supersedence + merge-suggestion pass), Plan D (seed from ~/.nlm/work-topics.json + match-only backfill + gold-set threshold derivation + verify + flip the flag on). Post-merge: rebuild dist on main + `launchctl kickstart` the daemon so running config matches source-of-truth. Deferred Minors to fold into Plan D flip: matcher exact-boundary tests; bind.ts orphan-workstream one-line comment. Also pending: #368 Settings UI embedder/classifier picker.

## 2026-06-24: configurable inference providers (classifier + embedder + code embedder to any OpenAI-compatible endpoint)

**Changes:** All three local-AI lanes are now pointable at any OpenAI-compatible endpoint (local or cloud), defaulting to Ollama. Classifier: `NLM_CLASSIFIER=openai` + `NLM_CLASSIFIER_BASE_URL`/`_MODEL`/`_API_KEY`/`_MAX_TOKENS`. Prose embedder: `NLM_EMBED_PROVIDER=openai` + `NLM_EMBED_BASE_URL`/`_MODEL`/`_API_KEY`. Code embedder follows the same destination with its own `NLM_CODE_EMBED_MODEL`. New code: `DeepSeekClient` gained `responseFormat` ('json_object'|'none') + `classifyMaxTokens` options; `OpenAIEmbedderClient` and `OpenAICodeEmbedderClient` (new, `/v1/embeddings`, l2-normalized, nomic/CodeRank prefixes); `ClassifierBox` 'openai' provider; `buildEmbedder()`/`buildCodeEmbedder()` in `cli/nlm.ts`; baseUrl-aware `classifierEgressNotice`; exported `EMBED_PREFIXES`/`MAX_EMBED_CHARS` + shared `buildCodeEmbedPrompt`. +15 tests.
**Decisions:** Verified against live LM Studio, not assumed: its MLX engine rejects `response_format: json_object` (omit it) and cannot disable thinking via API (`/no_think` and `chat_template_kwargs.enable_thinking:false` both ignored), but reasoning lands in a separate channel so `content` stays clean JSON, so give `max_tokens` headroom (default 8192) instead of fighting CoT. Re-embed the whole corpus (not mix) because Ollama was down so the Ollama-vs-LMStudio nomic spaces could not be A/B'd. Code embedder follows the prose destination but keeps CodeRankEmbed as its model. The recall rewriter is the embedder (not the classifier), so `OpenAIEmbedderClient.rewriteForRecall` throws `LLMUnreachableError` (recall fails open to the raw query).
**State:** Live on LM Studio (Mac Studio `:1234`): classifier `qwen3.5-4b-mlx` (5.2s real classify), session corpus re-embedded 3830/3830 via nomic-v1.5, code 79/79 re-embedded via CodeRankEmbed (`text-embedding-coderankembed`); post-migration recall verified relevant. Ollama torn down on the Mac Mini (the `ollama-keepalive` 60s relauncher + host/app agents booted out, reversible). Daemon restarted onto the build, healthy. Typecheck clean; full suite green except the pre-existing `cli-work-digest` unhandled-rejection flake. Branch `feat/configurable-inference-providers`, not pushed.
**Next:** #368 Settings UI picker (embedder + the openai classifier provider as a first-class providers-registry kind with base-URL, `/api/embedder` swap + an `EmbedderBox`, a Settings page mirroring Classifier, Ollama default preserved, re-embed warning on change). Code-exemplar lane is dormant (no producer yet); fully active migration revisited when it produces. #367 workstream spec is on its own branch awaiting review.

## 2026-06-23 — recall latency fix, push→pull pivot, runtime attribution, work-digest Phase 1

**Changes:** #364 daemon recall latency fixed — FTS5 warmup-on-start (cold 37s → ~400ms) + `AbortSignal` on the exemplar-embed race (warm+enrichment ~80-120ms, was ~4-8s spikes). Option B shipped: new `NLM_HOOK_PROMPT_RECALL=off` disables per-prompt ambient recall, independent of `NLM_HOOK_MODE` (session-start layer + pull tools stay). Runtime attribution added to both pull paths — `recall_sessions`→query_log, `recall_facts`→fact_query_log — from the MCP client's `clientInfo` (`mcpRuntimeFromClient`); `FactLogEntry` gained a `runtime` field. Work-digest Phase 1: `src/core/work-digest/` (active-time from transcript message-gaps, not `duration_min`), `work_summary` MCP tool, `nlm work-digest` CLI; generic NLM core with extension seams (pluggable topic provider, opaque `byTopic[].meta`).
**Decisions:** The recall gate has sound judgment but ~1.3s/fire on a loaded host (A/B: off 657ms vs shadow 1937ms) → demote ambient to on-demand pull; gate stays shipped+dormant as the pull-path filter. Active-time from message-gaps (real day reads 8.6h vs `duration_min`'s 87h). NLM core stays generic; NLOS + the future thread model ride on seams, never imported by core.
**State:** All on main + pushed; daemon restarted live. #364 done, #360 (judge keystone) closed. Built TDD via subagent-driven dev with per-task Opus real-corpus verification (caught a stdio-MCP wiring gap, a fixture math bug, a progress firehose, a committed scratch file). Known limitation: noisy default topics (`#345`, file paths) — `~/.nlm/work-topics.json` alias map is the stopgap.
**Next:** #366 validate option B over ~a week (mine `source=mcp` + `runtime=claude-code` pull usage/usefulness vs the ambient 37%/52% baseline); #367 thread/workstream abstraction (root-cause topic fix); work-digest Phase 2 (Telegram/email push) + Phase 3 (UI chart); draft `work-topics.json`.

## 2026-06-22 (cont.) — context-recall shipped + the measurement-apparatus reckoning

Continuation of the big production-drive day. Shipped 11 PRs (#38–#48). After the corpus/honesty fixes, the arc converged on the real bottleneck: the usefulness judge.

- **Honest digest (#39):** report true cited-precision (1%), not the surfacing rate (90%) that was hiding it.
- **Content gate (#40):** don't fire recall on contentless/harness prompts (IDE selections, task-notifications, bare acks). Measured over 8,666 fires: 53.8% of fires now skip recall entirely, 177 wasted injections eliminated, ZERO real-query regressions.
- **Usefulness harness (#41) + band filter (#46):** judge real *usage* (not citation) of injected context vs the agent's actual response — citation undercounts usefulness ~5–18×.
- **I5a invariant fix (#42):** the duplicate-fact check counted *retired* facts as active; retiring a dup never cleared it. Retired 2 stale dups; live I5a 3→1 (remaining = legit multi-valued `stack`).
- **cite_session conv-id (#43):** resolve the real conversation server-side from the surfaced-memo; ~379 orphaned `mcp_tool` citations → 0.
- **Context-recall (#44, LIVE):** recall on recent conversation turns for thin prompts. A/B (#45/#47): usefulness 29%→54%, off-topic 46%→8% (paired). Flag `NLM_HOOK_CONTEXT_RECALL=1`, reversible.
- **The reckoning:** the small local usefulness judge (qwen3.5:4b) is config-sensitive and unreliable (over-counts topical adjacency *or* over-corrects to all-unused; no config reliable across samples). So absolute usefulness numbers are untrustworthy — only PAIRED deltas hold. Built the judge-tuning framework (#48: `dump-gold-candidates.ts` + `tune-usefulness-judge.ts`; gold at `~/.nlm/eval/`, 13 frontier-labeled). **Keystone workstream = tune a small local judge against a frontier gold set (#360)** — prerequisite for trustworthy recall measurement AND telemetry. Killed (via mining): semantic-upgrade, dedup-degradation, "specific recall is fine", citation-as-learning-signal.
- **Resume:** expand the gold to ~50+ with used/partial balance, tune to match frontier, wire as the standing judge, then re-run recall-health + reranker + build telemetry. Detail: NocoDB #360.

_Older entries archived in CHANGELOG-2026.md_



## 2026-06-21 — exemplar Phase 3 (v0.17.0) + the oversized-session recovery arc (v0.18.0 → v0.20.0)

One long session: shipped code-exemplar supersedence, then diagnosed and closed out the never-ingested-large-session backlog across three releases.

- **Phase 3 — code-exemplar supersedence (v0.17.0):** retire/relabel captured exemplars with sticky `llm`/`human` provenance (human-wins). `retired_at` + `label_source` columns (SQLite migration 023 + consolidated `pg/001_initial.sql`), atomic `setVerdict` on both backends, `searchByVector` excludes retired (single recall-exclusion point), `supersede_exemplar` MCP tool + `POST /api/exemplar/:id/verdict`.
- **#339 — dropped 4 dead `pg/` migration one-shots** (`pg/018,020,021,022`): never applied (PG init reads only `001_initial.sql`) and drifted from canonical. Kept `pg/019` (a test applies it).
- **#274 — recall verification closed:** ran the deferred per-runtime live check (Claude Code) for the spec-F/G fact-injection pointer block; confirmed the "Known facts" section renders + the liveness canary; fixed two stale commands in `docs/testing-recall.md`.
- **#316 — thin-session reclassify:** re-classified 13 "thin" April sessions from their stored body (+262 entities, **0 decisions** — a low-value copy-editing batch). The dry-run-before-apply caught the low value; the real gap surfaced here: ~182 oversized sessions that never ingested.
- **#340 — hierarchical classification + recovery (v0.18.0):** `classifyLarge`/`classifyAdaptive` (deterministic map-reduce over chunks) + a `reclassify-oversized` CLI. Recovered 179/190 backlog sessions. (Scope correction: `num_ctx=16384` is ~50–60K *chars*, so the 200K cap already classifies — chunking is for coverage, not failure-avoidance.)
- **JSON-resilience (v0.19.0):** diagnosed the residual failures as *malformed JSON* (`done_reason: "stop"`, stray-quote payloads), not truncation. Client retry on transient schema/unreachable errors (`classifyAttempts`, default 3) + per-chunk tolerance in `classifyLarge` (one bad chunk no longer sinks a giant). Recovered 11 of the remaining 12.
- **#341 — scheduler auto-chunks oversized on ingest (v0.20.0):** the live scheduler classifies via `classifyAdaptive` with a *per-chunk* timeout (shared `src/core/util/with-timeout.ts`), so future large sessions auto-chunk instead of head-only extraction. Single-pass timeouts still propagate; per-chunk timeouts are tolerated.
- **Net:** ~183 of 185 never-ingested large sessions recovered (~211 decisions / ~734 facts of previously-lost decision-rich content now searchable). **Residual: 2** subagent transcripts whose content persistently breaks the classifier's JSON output (edge case, not chased). Full suite **1177 green** at session end; all four releases built via subagent-driven TDD with per-task + whole-branch reviews.

## 2026-06-19 — exemplar lane wired + Phases 1-2 shipped (v0.13.0 → v0.16.0)

Took the code-exemplar lane from shipped-but-dormant to a working capture→passive-recall loop, fixed a PG regression, and reconciled the task backlog.

- **The exemplar lane was staged-but-unwired.** `NLM_CODE_EXEMPLARS_ENABLED` gated MCP tools + HTTP routes that never received the store, and `extractExemplar` had zero callers — flipping the flag was a no-op. Threaded `storage.exemplars` + `OllamaCodeEmbedder` into `createApp` + `createMcpServer` and added a flag-gated capture hook (**v0.13.0**); then `recall_code` parity on the HTTP `/mcp` transport (**v0.13.1**) and a Postgres `PgCodeExemplarStore` (**v0.14.0**).
- **PgFactStore regression fixed (v0.14.1):** SQLite migration 022 added `facts.retired_at` but the consolidated `pg/001_initial.sql` was never mirrored → 12 `fact-store.pg` tests failed, PgFactStore broken on Postgres. One-line column add; root-caused #296.
- **Phase 1 — capture (v0.15.0):** the ingest scheduler detects the commit sha in a coding session, `git show`s the diff, labels it from the classifier's summary/decisions, and stores + embeds it. Zero-install, auto-populates from normal sessions; best-effort, never blocks ingest.
- **Phase 2 — passive recall (v0.16.0):** the recall hook embeds the prompt in CodeRankEmbed space and injects the top ~2 exemplars as a lean `## Related code exemplars` pointer section (no code body — `recall_code` pulls it). Flag-gated, 800ms-timeout-guarded, distance-filtered. (CI caught a `tsconfig.test.json`/`exactOptionalPropertyTypes` slip the partial local typecheck missed.)
- **Backlog reconciled:** confirmed the GitHub repo has 0 issues (NocoDB is the single source of truth; the `#NNN` refs in commits are NocoDB task ids); closed 7 already-shipped tasks (#162/#180/#181/#182/#183/#278/#328); pruned the branch tree to just `main`. All feature work built via brainstorm→spec→plan→subagent-driven-execution (per-task + whole-branch reviews).
- **Next:** Phase 3 supersedence (retire/relabel + `llm`/`human` provenance, human-wins) — spec §D + plan committed on `feat/exemplar-supersedence`, not yet executed (NocoDB #338). Open follow-ups: #336 (wire `applyBucketCap`), #337 (recall distance-threshold calibration), #331 (synthetic eval).

## 2026-06-17 — #325 + #326: fact retirement actually works + extractor stops ingesting noise

Closed the two defects behind permanent fact pollution (surfaced by the Tapboard recall-wander post-mortem).

- **#326 — `supersede_fact` / `mark_superseded` (fact-level) were cosmetic.** The handler called `markSuperseded(id, null)`, which set `superseded_by = NULL` — a no-op, since recall keys "active" on `superseded_by IS NULL`. Retired facts kept serving (verified: a fact still recalled after retiring). Root cause: retirement-without-a-successor was structurally impossible — invariant I5b requires `superseded_by` to reference a real fact, and self-supersede is guarded. Fix: new nullable `retired_at` column (migration 022 sqlite + `pg/022`), `FactStore.retire(id)` on both adapters (+ the pg tx-bound queue) that sets `retired_at` and drops the embedding so semantic recall can't surface it; recall excludes retired facts (keyword via `AND retired_at IS NULL` in findCurrent/list/listForRecall, semantic via embedding deletion); `includeSuperseded` and `getHistory` still surface them for audit. Handler now calls `retire()`; the audit-log append is unchanged.
- **#325 — the extractor ingested its own recall block + null-result values.** (a) `stripInjectedContext` removes the injected "Possibly-relevant prior sessions" / "Known facts about top entities" pointer block (header → `NLM tools:` footer, inclusive) before classification; wired into `ClassifierBox.classify` — the single seam ingest, scheduler, and backfill all funnel through. A dangling header with no footer is left intact (don't eat real content). (b) `isNonAnswerValue` gate in `coerceFacts` deterministically drops failed-observation values ("…result not provided", "did not run", "command not found", "unconfirmed…", "unknown…", "n/a", "tbd") — the local classifier is not trusted to self-police.
- **Tests:** +21 (retire contract ×5, handler ×5, retire→recall e2e ×1, strip-injected-context ×6, classifier-box wiring ×1, value-gate ×3). Full suite **1106 pass / 84 skip / 0 fail**; `build:server` + `typecheck` clean (the 7 pre-existing `*.pg.test.ts` `sourceQuote: null` errors remain untracked debt).
- **Pending deploy:** migration 022 auto-applies on daemon start (ALTER ADD COLUMN — metadata-only, fast); a rebuild + daemon restart is required for the live service. The 4 already-logged Tapboard retirements (recorded via the old no-op tool) need a re-run of `supersede_fact` post-deploy to take effect — the fact-level audit log is not auto-replayed.

## 2026-06-16 - River P0s + retro-close 3 PG tasks (#188, #190, #96/#215/#216)

Same session as #324. Reviewed the 96 open NLM tasks; closed the PG cluster's stragglers and the two River P0s.

- **#188 (P0) — drag-to-zoom precision** (PR #14, `fix/river-p0-zoom-labels`): drag-select rounded back to the nearest preset (7d/30d/90d/all), discarding the window. Added a `customRange {from,to}` state that takes precedence over presets in the view filter; `onMouseUp` now sets the exact dragged dates; toolbar shows a dismissible range chip with an SVG close icon (no glyph, per #201's convention); any preset button clears it.
- **#190 (P0) — unreadable date labels at 'all'** (same PR): stride thinning + month hairlines already existed; added always-on month-name anchors (month-start cells render "Jun" regardless of stride) with day numbers on the stride between — GitHub-contribution-strip pattern. Labels built from ISO string parts (no `Date`) to avoid TZ day-drift. `tsc` + `build:ui` clean; visual browser confirmation still pending.
- **Retro-closed 3 PG tasks the cluster already delivered:** #96 (PgSessionStore over pgvector + boot-time backend selection), #215 (FactStore port + both adapters, PR #215), #216 (PgFactStore impl + 32 contract tests). Each got a closure note; hosted-Teams productization continues under #217/#218.
- **Open tasks: 96 → 90** (closed #324, #96, #215, #216, #188, #190 this session). Pre-existing PG test failures hit during #324 (nested-txn, vector-L2) are already tracked under #296; the only untracked item is 7 `tsconfig.test.json` typecheck errors (`sourceQuote: null` literals).

## 2026-06-16 - #220: PG live ingest — PgSessionStore factSink + reachable scheduler + ingest-deps

`feat/pg-ingest-scheduler` (PR, stacked on #9). Completes the daemon's live-ingest path on PostgreSQL — the scheduler and webhook-push now actually work against PG, not just SQLite.

- **Root blocker fixed:** `PgSessionStore.insertSession` took only 3 args — **no `factSink`** — so PG ingest silently dropped facts while SQLite wrote session+facts atomically. Added the 4th `factSink` param: facts now insert inside the session's own `BEGIN/COMMIT` (DELETE-by-session + per-fact INSERT + batch `UPDATE … FROM (VALUES …)` supersedence, mirroring the SQLite path and `PgFactStore.ingestSessionFacts`), with best-effort fact embedding after commit.
- **`ScanScheduler` was scaffolded-but-unreachable:** `store` was typed `SqliteSessionStore` and PG detection used a duck-typed `store.pgPool?.()` that never matched `PgSessionStore` (`.pool`). Widened `store`/`factStore` to the backend union, switched detection to `store instanceof PgSessionStore ? store.pool : null`, and narrowed the `insertSession`/`recordClassified` calls per backend (the same-backend `factStore` cast is sound — store + factStore are always constructed together).
- **`ingestSession`/`IngestDeps`** (webhook `POST /api/ingest`) given the same union + narrowing.
- **`nlm start` wired for PG:** dropped the `!(storage instanceof PgStorage)` scheduler skip and the ingest-deps PG gate, plus all the `as SqliteSessionStore`/`as SqliteFactStore` casts. The WAL-checkpoint timer stays SQLite-only (correct — no WAL in PG).
- **Pre-existing PG bug fixed along the way:** `PgSessionStore.loadEdges` bound `[...ids, ...ids]` for two `IN` clauses that share the same `$1..$n` placeholders → `getById` on any PG session crashed with "supplies N parameters but requires M". Now binds `ids` once. (First exercised by the new test.)
- **`TODO(#215a)`: 3 → 1** — only the backfill PG path remains (`nlm.ts:632`; bespoke SQLite SQL in `backfill-facts.ts`, a separate offline-command rewrite, explicitly deferred).
- **Tests:** new `pg-ingest.pg.test.ts` (gated on `NLM_PG_TEST_URL`) — atomic session+facts commit, supersedence on re-ingest, and a **full `ScanScheduler.tick()` over PG** asserting the session, its facts, and `adapter_state` (proves the PG branch ran). **3/3 + the wider PG suite green** vs a fresh `pgvector/pg16` container; full default suite **1090 pass**; typecheck clean. SQLite scheduler/ingest tests unchanged (27 pass).

## 2026-06-16 - PR #7 merged; #215a: clear app.ts of all rawDb/cast escape hatches (registries + actions + data-mgmt)

Merged PR #7 (squash, `d3851c2`) — the 5-P1 fact-recall + install-hardening + backups branch. Then worked the architecture-refactor cluster on `feat/pg-registry-actions` (PR #8), clearing **app.ts from 8 → 0 `TODO(#215a)` sites**.

- **Finding:** #215/#216 already shipped the FactStore/Storage ports and the PG adapters (`PgStorage`, `PgFactStore`, `PgSessionStore`, `PgSourceRegistry`, `PgProviderRegistry`, PG actions-log functions). The remaining `TODO(#215a)` work in app.ts was purely *wiring* — the HTTP routes down-cast `deps.sources`/`deps.providers` to the SQLite registry classes and called them synchronously, so the PG path silently serialized Promises (a real latent bug, masked by the casts).
- **Registries + actions:** source + provider routes now `await` every registry call with the casts removed; the union (`SourceRegistry | PgSourceRegistry`) resolves cleanly because `await` is transparent on the sync SQLite path. Action routes branch on `liveStore instanceof PgSessionStore` → `writeActionPg`/`writeActionsBatchPg`/`undoActionPg`/`listActionsPg`. Filled the PG registry method gaps: `PgSourceRegistry.getByName`/`findByToken`/`regenerateToken`, `PgProviderRegistry.getByName` (+ `pgRowToSource` mapper). `PgSessionStore.pool` made public-readonly so the PG actions-log siblings share the pool.
- **Data-management (`/api/data/*`):** `/api/data/stats` gets a PG-native branch (`pg_database_size` + COUNT/migrations/runtime via `pgDataStats`; SQLite path unchanged via `sqliteDataStats`), preserving the UI response shape (`dbPath:"postgresql"` for PG). `/api/data/backup` + `/restore` are `VACUUM INTO`/file-swap mechanisms — inherently SQLite — so they now return **501 with delegation guidance** on PG (`pg_dump`/`pg_restore`/managed-PG snapshots) rather than shelling out from the daemon. Conservative + reversible: native PG backup can be added later if wanted.
- **Tests:** `tests/integration/registry-actions.pg.test.ts` (gated on `NLM_PG_TEST_URL`) — first-ever direct PG registry coverage + the data-mgmt routes via `createApp`/`app.request`. **8/8 green** against a disposable `pgvector/pgvector:pg16` container. Full default suite **1090 pass** (PG tests skip without the env var). The pre-existing `storage.pg` "nested withTransaction" failure reproduces on clean `main` — not from this change (tracked as #296).
- **Remaining for #220** (9 sites, all in nlm.ts, none in app.ts): CLI scheduler (`:332`) + backfill (`:641`) PG paths, the ingest-deps cast (`:241`), the registry *construction* sites (`:190`/`:195`, removable only via a Storage-port `sources()`/`providers()` accessor), and the SQLite-local `connect`/`disconnect` rawDb sites (inherently single-backend — likely just reword the marker). Removing the `pgPool()` escape hatch entirely is blocked on the accessor refactor + scheduler/backfill PG paths.

## 2026-06-16 - Fact-recall coverage + semantic-primary hybrid + install hardening + backups (5 P1s)

Branch `feat/fact-recall-coverage` (PR #7, ~10 commits, 1090 tests green).

- **#277 recall engine.** Built the missing fact-recall benchmark (`scripts/eval/fact-recall-eval.ts`, topic + LLM-paraphrase gold). It exposed two bugs: (1) `listForRecall`'s 500-most-recent candidate cap made ~93% of 7,486 current facts unreachable and silently gated the semantic leg — fixed with `FactStore.getByIds` corpus-wide neighbour resolution (semantic R@5 15% → 98.8%, found 12/80 → 80/80); (2) the equal-weight hybrid blend diluted strong semantic hits — redesigned `mergeHybrid` to semantic-primary backfill (hybrid R@5 73.8% → 85% on the hard paraphrase set), preserving the Ollama-down keyword fallback. Report: `reports/recall-experiments/2026-06-16-fact-recall-coverage.md`.
- **#313 / #311 / #312 install hardening.** `nlm doctor` install-health section; `nlm verify` release-gate (+ synthetic recall smoke test + fresh-install matrix in `docs/install-verification.md`); `nlm connect codex --repair`. Live-run of repair caught wrong stale-config-shape assumptions + a duplicate-key TOML break that broke Codex parsing — fixed (precise `@nlm-memory-ts` suffix match; `writeMcpServerToConfig` never duplicates a pre-existing table).
- **#210 backups.** `nlm backup` (rolling daily VACUUM INTO snapshots + 7d retention prune) and `nlm restore --from <date>` (non-destructive, applied on restart). Docs in `docs/backups.md`; daily scheduling documented (launchd/cron), not auto-installed.
- Also: `keep_alive:0` on the Ollama classifier so the 3.6 GB model unloads after each call instead of pinning RAM.
- Next: architecture refactors #215/#219/#220 (FactStore adapter likely already exists; live work is the ~18 `rawDb()` → PG-native migrations — grep `TODO(#215a)`).




## 2026-06-15 - Code-exemplar recall: design + embedder eval (open question resolved)

Design session for a new lane: retrieve "code that worked for a task like this" — the exemplar complement to the existing statistical signals lane. Plan at [docs/plans/2026-06-15-code-exemplar-recall.md](../../docs/plans/2026-06-15-code-exemplar-recall.md).

**Reframe: this extends signals, not net-new.** The signals lane (migration 017) already captures `outcome ∈ {pass,fail,fix,exhausted}` per `(install_scope, repo, model, step)`, append-only, model-agnostic, embedding-free by design. The outcome label already arrives at ingest from the producer — git survival is *secondary* enrichment, not the primary signal. Missing pieces are only: code content, a code embedding, and a similarity retrieval path. Design adds a `code_exemplars` table (sibling to `signals`, keeps it lean), a second embedding lane behind the port with `nomic-embed-text` fallback, a pull-only `recall_code` MCP tool (returns positives AND labeled negatives), and lazy git-survival rerank. No prompt/citation hook changes; extraction rides the daemon-side signal ingest path so every runtime gets it free. Vendor-neutral throughout (outcome from producer, code from git diff, `install_scope` isolation, open embedder).

**Embedder eval — open question 1 RESOLVED.** Can a lightweight code embedder run under the existing Ollama dependency, and does it beat the prose baseline? Both yes. `ollama pull hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF` (146 MB Q8, 768-dim) serves cleanly via Ollama — no new runtime, zero-config holds. Retrieval eval (24-chunk polyglot corpus, 18 NL→code queries with hard near-distractors, correct prefixes per model): **CodeRankEmbed Recall@1 94.4% / R@5 100% / MRR 0.972 vs nomic-embed-text 61.1% / 94.4% / 0.731** (+33pp R@1, +0.24 MRR). Baseline misses are exactly the adjacent-but-wrong cases (debounce vs throttle, retry vs timeout, SQL/list ops collapsing to one topic) — prose embedder clusters by topic, code embedder discriminates by behavior. Caveat: 18 queries is a feasibility signal, re-confirm at scale on the synthetic eval. Decision: CodeRankEmbed-Q8 via Ollama is the default code embedder.

**Open questions all resolved (same session).** (2) Chunk granularity: whole changed hunk, size-banded ~2-200 meaningful lines, labeled with git's hunk-header funcname, `code_hash` deduped; function-level split deferred to v2 via git funcname + brace/indent heuristic, never a heavyweight parser (keeps zero-config + polyglot-agnostic). (3) Retention: dedicated, quality+dedup bounded not clock bounded (signals decay, exemplars don't) — `code_hash` dedup + prune `survived=0` reverted rows + per-bucket cap `NLM_EXEMPLAR_MAX_PER_BUCKET` (default ~20) over `(install_scope, repo, lang, outcome-class)`; `NLM_EXEMPLAR_RETENTION_DAYS` default 0=off as escape hatch.

**Next: plan is build-ready.** Build order: migration `0XX_code_exemplars` (+ pg mirror) → `CodeExemplarStore` port+adapter → extractor on the signal-ingest path (git-diff sourcing first) → code embedder behind the port w/ `nomic-embed-text` fallback → `recall_code` MCP tool (positives + labeled negatives, `survived` rerank) → synthetic eval. All behind `NLM_CODE_EXEMPLARS_ENABLED` (default off).

## 2026-06-11 - Precision simulation, recall research, and the #307 null result that corrected the diagnosis

**Precision simulation (evening 06-10 → 06-11).** Built a sandboxed harness replaying 40 corpus-derived decision questions through the full production pipeline (recall API → query_log → citation API → `nlm precision`). First real-corpus retrieval numbers: **R@5 72.5%, R@1 52.5%, mean rank 1.52** - vs the 96.6%/97.2% small-haystack benchmark numbers. Simulated mcp-lane precision 14.5% vs 20% structural ceiling (~73% of achievable). Also found+fixed a display bug (`68cb90f`): the per-source table was hidden whenever the hook lane had no scoreable conversations. The harness lives on as a monthly corpus-scale trend fixture.

**Recall-accuracy research.** Field scan (mem0/agentmemory/Zep/Letta/LangMem/MemoryOS) + Dallas AI talk analysis. Key validations: Zep's non-destructive edge invalidation = NLM's supersedence philosophy (the "marking" camp vs the "forgetting" camp); mem0's published 25% degradation at 10M tokens confirms corpus-scale decay is the unsolved industry problem; destructive decay rejected again - it shrinks candidate pools and our problem was never noise.

**#307 candidate-stream experiment: null result, diagnosis corrected (`982cdda`, report only).** Arms: facts-lane merge, entity-match leg, semantic cascade, RRF control - none improved R@5; nothing shipped; all experiment code removed. The load-bearing finding: keyword already returns 200-344 candidates per query including 10/11 missed golds - **the candidate pool was never the bottleneck**. 4/11 misses are BM25 near-misses at rank 6-8 (ranking problem); the rest are deep paraphrases at rank 18-37 (query-side problem). RRF control regressed to 65%, confirming the May finding at real scale. Yesterday's "candidate-generation, not ranking" conclusion is overturned by measurement - filed #308 (entity/fact tiebreaker on existing candidates + confidence-gated query reformulation).

**Infra:** Qwen3-Coder-Next agent lane wired (`~/.claude-code-router/config-qwen-next.json` → Mac Studio oMLX direct); calibration task = #295 UI sweep. Open: #294, #295, #296, #308.

## 2026-06-01 — `nlm connect pi` + plugin-pi auto-discovery manifest

## 2026-06-02 — v0.5.20: pi extension renamed `plugin-pi/` → `nlm/`, displays cleanly in pi's `[Extensions]` list

Closing a v0.5.19 cosmetic gap: pi's `[Extensions]` header line surfaced `nlm-extension.mjs` (the file leaf) instead of a clean name like `nlm` matching the sibling extensions (`pi-mcp-adapter`, `pi-token-speed`, `pi-web-access`, `whtnxt-tasks`). Read pi 0.76's `dist/modes/interactive/interactive-mode.js` to find the cause: `getCompactExtensionLabels` hard-strips only `/index.ts$` and `/index.js$` from the load path. `.mjs` doesn't strip. Subdirectory-targeted manifest entries display the leaf, not the parent directory name. Local-path entries are never treated as "package sources" for display (only `npm:`/`git:` are), so they fall through to the strip-then-basename path.

**Layout change:**
- `plugin-pi/` → `nlm/`
- `plugin-pi/scripts/nlm-extension.mjs` → `nlm/index.js` (esbuild output target updated in `scripts/build-codex-plugin.mjs`)
- Dropped the `pi.extensions` manifest field from `nlm/package.json` — pi auto-discovers `index.js` at the root and `formatExtensionDisplayPath` strips it
- **Must be `.js` not `.mjs`** because pi's strip regex is literal. `nlm/package.json` still carries `"type": "module"` so the bundle stays ESM.

**Migration:** `connectPi` now strips any legacy `plugin-pi` basename from `packages[]` before adding the new `nlm` path. `disconnectPi` strips both basenames. Idempotent. Upgrading users with the old entry get migrated on next `nlm connect pi` or `nlm setup` run with no manual cleanup. Smoke-tested with a sandbox that had `["npm:foo","/old/path/plugin-pi","npm:bar"]` — after connect, the result was `["npm:foo","npm:bar","/Users/.../nlm-memory-ts/nlm"]`.

**Net display:**

```
[Extensions]
  nlm, pi-mcp-adapter, pi-token-speed, pi-web-access, whtnxt-tasks
```

Tests: 726 passed (no regression). Source surface for the rename: 16 files, +116/-67 lines; the bulk is dist/ output and the README/CHANGELOG/package.json/install/pi.ts edits. Committed `197422f`, pushed, published.

## 2026-06-02 — classifier benchmark + qwen3:4b head-to-head with DeepSeek V4 + README/SECURITY honesty pass

Reacting to public feedback that "the project doesn't match the implementation" (promotes local-first while defaulting to DeepSeek API) and that "the security story seems weaker than the README suggests." Built the evidence base to answer the "can a local model replace DeepSeek V4 Flash" question honestly, then redacted privacy leaks before publishing.

**Classifier head-to-head (N=20, real Claude Code coding sessions, identical prompt).** DeepSeek V4 Flash vs `qwen3:4b-instruct-2507-q4_K_M`: statistical tie on structure (20/20 JSON valid both, median 12 vs 13 entities, 3.5 vs 3 decisions, 2.5 vs 3 open questions). qwen3 leads on open-question coverage (100% vs 75% of sessions with ≥1 open). DeepSeek 3.5× faster (11s vs 40s). Cost: $0 vs ~$0.003/session. Full data: [reports/classifier-comparison/2026-06-02-deepseek-v4-vs-qwen3.md](../../reports/classifier-comparison/2026-06-02-deepseek-v4-vs-qwen3.md).

**README + SECURITY honesty pass.** Flipped `NLM_CLASSIFIER` default from `deepseek` to `ollama` with `phi4-mini:latest`. Hero blurb up-front: local-first means Ollama by default; cloud is opt-in. 97.2% R@5 claim labeled with DeepSeek V4 attribution; methodology doc explicitly names `deepseek-v4-flash` as the classifier that produced the labels. Exhaustive outbound-traffic table (npm registry update check now disclosed). New "Honest caveats" section calls out plaintext API key storage (with keychain roadmap), prompt-injection-via-indexed-session, and fail-open hooks. `setup.ts` wizard reorders Ollama (local, recommended) first. SECURITY.md threat model: "Known limitations" + "What is in scope" + clean out-of-scope. Test badge 612 → 742.

**LongMemEval-S harness: classifier-in-the-loop measurement.** New `--classifier <none|ollama:model|deepseek:model>` flag on `scripts/longmemeval/run-harness.ts` plus `--stratify` for sampling across all 6 question types (the first 70 instances are all `single-session-user`, the easiest category). `scripts/longmemeval/classifier-cache.ts` is a SQLite cache keyed by `sha256(provider+model+body)`, stores successes and persistent failures so flaky models aren't retried indefinitely (138 lines + 7 unit tests, all green). `compare-classifiers.ts` renders side-by-side markdown from N `results.json` files. `npm run` aliases: `bench:longmemeval`, `bench:classifier`, `bench:compare`.

**LongMemEval-S can't differentiate classifiers — published finding.** Stratified N=60 body-only vs `qwen3:4b-instruct-2507` produced exact-tie R@5 across every mode and question type. Haystacks too small (~40 sessions) for entity-enrichment to add signal on top of keyword scoring. Also: 33% schema-failure rate on qwen3 against LongMemEval-S (personal-life conversation legitimately lacks `decisions[]`/`open[]`) vs 0% on coding sessions — the classifier prompt is implicitly tuned for AI-coding-agent transcripts. Transparent in `cache_ok / cache_failed` reporting.

**Privacy guard install (global, host-wide).** Caught a near-miss: a draft committed but unpushed file (`scripts/whtnxt-bench/queries-draft.md`) listed active clients, pricing, NordVPN allowlist, and 50 internal session IDs; `docs/methodology-recall-baseline.md` had a pre-existing client-name reference since v0.5.4. Audited, redacted, then installed `~/.git-hooks/pre-push` with `core.hooksPath = ~/.git-hooks` globally. Patterns at `~/.config/git-privacy/patterns.txt` (one ERE regex per line, lives OUTSIDE any repo). Scans added lines in the push diff; blocks with exit 1 if any pattern hits. Tested positive (3/3 deliberate hits caught) and negative (already-redacted commit cleared).

**Whtnxt-bench draft (private, not committed).** 50-question corpus-specific R@5 benchmark draft at `~/Documents/nlm-private-bench/queries-draft.md` (intentionally outside the repo — contains client names and pricing). Each question carries verified gold session IDs from `recall_sessions`. Pending review before the corpus-specific harness build.

**Recommendation for next minor release.** Default the local classifier to `qwen3:4b-instruct-2507-q4_K_M` in `src/install/setup.ts` and `src/core/providers/provider-registry.ts seedDefaults()`, replacing `phi4-mini:latest`. Same RAM bucket (3.5 GB vs 2.4 GB).

Pushed: commit `b5716d2` on `main` after redaction audit.

**Next:**
- Edward review of `~/Documents/nlm-private-bench/queries-draft.md`
- Build `scripts/whtnxt-bench/run-harness.ts` once queries are locked
- Land the qwen3:4b default flip in a minor release

Closing the two gaps that meant the prompt-recall extension shipped earlier today wasn't actually reachable for users installing nlm-memory fresh.

**Gap 1 — bundle wasn't in the npm package.** `package.json` `files:` listed `dist, plugin, assets, LICENSE, README.md`. Added `plugin-pi`. Now `npm publish` (and `npm i -g nlm-memory`) ships the bundle.

**Gap 2 — no install command.** Other runtimes had `nlm connect <runtime>` wrappers (claude-code, codex, hermes, hermes-agent, cursor, windsurf) but pi didn't. Added `nlm connect pi` / `nlm disconnect pi`:

- `src/install/pi.ts` — `connectPi({ pluginDir })` reads `~/.pi/agent/settings.json`, appends the absolute path of `plugin-pi/` to its `packages` array, writes back as pretty-printed JSON (matches pi's own write convention). Idempotent: existing entries with the same resolved path are detected and no-op. `disconnectPi` strips by basename `plugin-pi`. Settings dir override via `NLM_PI_AGENT_DIR` for testing.
- `src/cli/nlm.ts` — wired connect and disconnect subcommands alongside the other six runtimes. Dry-run flag supported for both.

**Pi auto-discovery contract.** Pi's loader resolves each `packages` entry that's a directory by reading `package.json` and, if a `pi.extensions` field is present, loading the declared modules. New `plugin-pi/package.json` declares `pi.extensions: ["scripts/nlm-extension.mjs"]`. Pi accepts `.mjs` via this manifest path (the `.ts`/`.js`-only file-extension filter only applies to bare-file discovery, not manifest entries). Verified by reading `dist/core/extensions/loader.js` from `@earendil-works/pi-coding-agent@0.78.0`.

**Smoke test.** Ran connect/idempotent-connect/disconnect/idempotent-disconnect against a sandboxed `NLM_PI_AGENT_DIR` with an existing `packages: ["npm:foo"]`. Result: `npm:foo` preserved across all four operations, plugin-pi path appended on first connect, no-op on second, removed on disconnect, no-op on second disconnect. Output messages clean.

**README + runtime-pi.md updated.** Main runtime table now reads `nlm connect pi` for the Connect column. `plugin-pi/README.md` leads with the wrapper and keeps the manual `pi -e` line as fallback. Whtnxt Agent's `runtime-pi.md` NLM section documents the install line.

**Setup wiring.** `nlm setup` (the interactive first-run wizard, the canonical onboarding path) auto-detects pi via `~/.pi/agent/sessions` and now calls `connectPi` automatically — the old "pi.dev: session scanning enabled (passive — no extra config needed)" log line is replaced with a real install step that mirrors how the wizard wires claude-code, codex, and hermes. Users who run `nlm setup` once never need to know the `nlm connect pi` command exists.

**Net user flow now:** `npm i -g nlm-memory` → `nlm setup` → pi.dev is detected and wired automatically → restart pi → prompt-recall fires on every input. (`nlm connect pi` remains available for users who skipped setup or want to re-wire after adding pi later.) Optional: `NLM_HOOK_MODE=live` in `~/.nlm/.env` to flip from shadow to live injection.

## 2026-06-01 — pi.dev prompt-recall extension

Pi.dev now has an active prompt-recall hook to match Claude Code's `UserPromptSubmit` injection — not just passive transcript ingestion. Pi's hook surface is a TypeScript extension API (`pi -e <path>`), not config-file hooks, so the install is a single bundled extension module loaded at pi startup.

**New module:** `src/hook/pi-extension.ts` — default export registers a `pi.on("input", ...)` handler that classifies the prompt (generative → skip, evaluate → recall), calls `/api/recall?mode=keyword` against the local daemon, applies the same per-conversation memo and pointer-block formatter as the Claude hook, and returns `{ action: "transform", text: "${block}\n\n${event.text}" }` to prepend the block to the user's prompt. Fail-open: any error returns `{ action: "continue" }`.

**Shared helper extracted:** `recallOverHttp` and recall constants moved from inline in `src/hook/prompt-recall-hook.ts` to `src/hook/recall-over-http.ts` so both the Claude `.mjs` and the pi extension share one HTTP client. Behavior unchanged — 32 existing hook integration tests still pass.

**Build:** `scripts/build-codex-plugin.mjs` extended with a per-target config (entry, outDir, banner). Pi bundle lands at `plugin-pi/scripts/nlm-extension.mjs` (no `#!/usr/bin/env node` banner — it's loaded as a library, not run as a script). Claude bundles unchanged.

**Distribution:** new `plugin-pi/README.md` documenting install (`pi -e $(npm root -g)/nlm-memory/plugin-pi/scripts/nlm-extension.mjs`), env vars (`NLM_HOOK_MODE`, `NLM_PORT`, `NLM_MCP_TOKEN`), and what's *not* shipped (no stop-hook — the passive adapter already covers it). Main `README.md` runtime table updated: pi row now reads `pi -e .../plugin-pi/scripts/nlm-extension.mjs` for Connect and `input (prompt-recall)` for Hooks.

**Smoke test verified end-to-end against the running daemon.** Generative prompt ("write a haiku") correctly skipped recall; evaluate prompt ("what did we decide about pgvector vs Qdrant") got 5 hits from `/api/recall`, would-inject top 3 in shadow mode, logged to `~/.nlm/hook-log.jsonl` with `conversationId: pi-smoke-test-1` and `mode: "shadow"`.

**Next:** no follow-up pending. Optional polish: `nlm connect pi` wrapper to write the `pi -e` line into the user's shell profile automatically (currently manual).

## 2026-05-31 — #216 PG adapter: PgStorage + contract tests + registry/actions/scheduler wiring + NLM_PG_URL bootstrap

Shipped the PostgreSQL storage adapter as an optional drop-in for SQLite. `NLM_PG_URL` selects PG; absent means SQLite. All 13 tasks implemented via subagent-driven development with spec compliance + code quality review after each.

**Core design — write-queue pattern for the sync/async port bridge.** `withTransaction<T>(fn)` takes a sync callback (the port was designed for SQLite's synchronous `db.transaction()`), but PG is async. Solution: `PgTxBoundFactStore` and `PgTxBoundSessionStore` collect `QueuedOp[]` entries synchronously inside the callback; `PgStorage.withTransaction` flushes the queue in a single `BEGIN/COMMIT` after the callback returns. Read methods on the bound stores throw — they cannot observe uncommitted queue state. No port interface change required.

**New modules:** `pg-tx-context.ts` (QueuedOp + both Tx-bound stores), `pg-fact-store.ts` (BEGIN/COMMIT per write method, pgvector `<->` L2 distance, `websearch_to_tsquery` FTS, `FOR UPDATE` on undo), `pg-session-store.ts` (max-pool semantic search, GIN FTS index, `insertSessionForTest`), `pg-storage.ts` (`pgPool()` `@deprecated` escape hatch for 18 `rawDb()` callers pending #215a). `migrations/pg/001_initial.sql` — full DDL mirroring SQLite 000–016, `vector(768)` columns, `fts_vector GENERATED ALWAYS AS`, ivfflat + GIN indexes.

**Registry/actions/scheduler:** `PgSourceRegistry`, `PgProviderRegistry`, `writeActionPg`, `scanOncePg`, `recordFailedPg` added as PG-native counterparts. `scheduler.ts` duck-types `pgPool()` to branch SQLite vs PG paths. `app.ts` + `nlm.ts` wired to `buildStorage()` which returns `PgStorage` when `NLM_PG_URL` is set.

**Contract tests:** `tests/contract/storage.contract.ts` (`runStorageContract`) + `tests/contract/fact-store.contract.ts` (`runFactStoreContract`) — adapter-agnostic harnesses injectable into both SQLite and PG suites. PG integration tests gate on `NLM_PG_TEST_URL` via `describe.skipIf` — pass gracefully without a PG host, full coverage when one is present.

**Security fixes caught in review:** `keywordSearch` was assembling tsquery strings via token concatenation — SQL injection risk. Changed to `websearch_to_tsquery('english', $1)` with raw user input. `undoActionPg` had its SELECT outside the transaction — moved inside with `FOR UPDATE` to prevent TOCTOU race when concurrent undo calls target the same action.

**Follow-up:** #215a — migrate the 18 `rawDb()` call sites in `app.ts` to PG-native queries, then remove the `pgPool()` escape hatch.

**Tests:** Full suite green (742 existing SQLite tests pass; PG integration tests skip gracefully without `NLM_PG_TEST_URL`).

## 2026-05-30 — v0.5.10 → v0.5.18: auth-hardening arc (nine releases, one session)

v0.5.9's update banner exposed a gap: `npm i -g` swaps the binary on disk, but the running daemon stays on old code in memory. Closing that surfaced a chain of regressions in the HTTP auth model. Nine releases later, the daemon ships with explicit opt-in UI auth (default off), a rolling-expiry cookie when on, and a nonce-based bootstrap that never puts the secret in a URL.

**The shipped releases:**

- **v0.5.10 — `nlm restart`.** Kickstarts the LaunchAgent on macOS (`launchctl kickstart -k`), restarts the systemd user unit on Linux, falls back to `pkill -f <pattern> + spawn` when neither is managing the daemon. Planning logic extracted to `restart-helpers.ts` with 8 unit tests.
- **v0.5.11 — pkill self-kill fix.** Self-review caught that `pkill -f "nlm.*start"` matches `nlm restart` itself. Tightened to `nlm\.(js|ts) start`, extracted to `DAEMON_PKILL_PATTERN` with positive/negative match tests so a future "improvement" can't reintroduce the bug.
- **v0.5.12 — Sec-Fetch-Site bypass for same-origin GET fetches.** Closed the `/ui/pulse` 401 from browsers that omit `Origin` on same-origin GETs. Reverted in v0.5.13 after security review flagged it [HIGH] as a port-forward bypass (any HTTP client can spoof Fetch Metadata headers).
- **v0.5.13 — Cookie-based UI auth + nonce-bearing `/ui/auth?t=<token>` bootstrap.** Cookie value = `HMAC-SHA256(NLM_MCP_TOKEN, "ui-session.v1")` so a cookie leak doesn't reveal the token. `/ui/*` and `/api/*` accept cookie or Bearer. `Sec-Fetch-Site` heuristic removed.
- **v0.5.14 — `nlm ui` reads `.env` via `autoloadEnv()`.** Was silently opening unauthenticated `/ui/` because the CLI shell didn't have `NLM_MCP_TOKEN` exported (daemon autoloads, CLI didn't).
- **v0.5.15 — Removed the paste-token form on `/ui/auth`.** Static instructions page only ("Run `nlm ui` from a terminal on this machine to sign in"). Wrong-token returns byte-identical response — no oracle for token-shape probing.
- **v0.5.16 — Nonce-based bootstrap.** New `POST /api/ui-bootstrap-nonce` (Bearer-protected, in-memory store) mints a single-use ~60s-TTL nonce. `nlm ui` posts to mint, then opens `/ui/auth?nonce=<x>` — the token never touches a URL. Closes the v0.5.13 token-in-browser-history leak.
- **v0.5.17 — Opt-in UI auth + rolling expiry + `nlm config ui-auth`.** `NLM_UI_AUTH=cookie|none`, default off. Decouples UI auth from `NLM_MCP_TOKEN` (which exists for unrelated MCP-over-HTTP reasons). Rolling expiry re-issues `Set-Cookie` on every authenticated `/ui/*` and `/api/*` hit so active sessions never expire. New `nlm config ui-auth on|off` writes `NLM_UI_AUTH` to `~/.nlm/.env` via idempotent format-preserving edit. Misconfig (`NLM_UI_AUTH=cookie` without `NLM_MCP_TOKEN`) fails closed with HTTP 500.
- **v0.5.18 — `nlm ui --print` + README "Remote access" section.** Prints the bootstrap URL to stdout instead of opening a browser — for SSH-and-paste flow when accessing via Tailscale on a different device. README points at `tailscale serve --bg http://localhost:3940` as the recommended remote-access path (default-off + Tailscale's WireGuard auth = sufficient for personal tailnets). Deliberately declined to ship `nlm serve --tailscale` — wrapping Tailscale's CLI is scope creep.

**Tests.** 742 passing (was 671 at session start). 71 new across the arc: nonce store semantics (mint/redeem/TTL/single-use), cookie HMAC + timing-safe verify, gate behavior under VITEST-unset, rolling expiry on /ui/* and /api/*, fail-closed misconfig, env-file editor idempotency (insert/update/remove/value-formatting/special-key-collision), pkill pattern positive+negative match.

**One systemic gap exposed and partially closed.** The local-only gate was skipped under VITEST since it was first added. Tests existed for every route but never exercised the auth middleware. The new `HTTP local-only gate` and `HTTP UI gate` describe blocks explicitly unset `VITEST`/`NODE_ENV` in `beforeEach` so the gate runs. Existing tests stay on the bypass path. Next regression in the same middleware will be caught by the new tests; tests written before today are still gate-free. Full coverage flip is a separate refactor.

**Two findings from `security-guidance@claude-code-plugins` addressed during the arc.** v0.5.12 Sec-Fetch-Site [HIGH] → reverted in v0.5.13. v0.5.15 token-in-URL [MEDIUM] → fixed in v0.5.16 with the nonce design. The reviewer's secondary v0.5.15 finding (paste-form-as-vector) was already-shipped by removing the form entirely.

**Next:** if cookie auth becomes the default in a future install, the `nlm ui --print` + SSH remote-bootstrap flow works today. No follow-up pending.

## 2026-05-30 — v0.5.8: operator-grade supersedence UX (CLI + UI)

Closes the hostile-UX problem flagged in this morning's product assessment. The `mark_superseded` MCP tool shipped earlier today required passing two opaque UUIDs by hand — defensible as a demo prop, not a feature anyone would reach for. v0.5.8 adds the two surfaces an operator actually inhabits: a `nlm supersede` interactive CLI and a SessionDrawer overflow menu that opens a search-and-pick palette modal. UI/UX agent design pass picked SessionDrawer + CLI as the two paths matching the cognitive trigger ("wait, that's outdated" fires while reading a recall result, not while staring at a calendar grid). Two Sonnet QA agents then audited each surface; this release ships the seven blockers and four cheap wins they identified.

**Backend.** New `POST /api/session/:id/supersede` endpoint in `src/http/app.ts` mirrors the `mark_superseded` MCP tool — same `markSuperseded()` port call, same audit-log write, same idempotency. Mirrored validation: 400 on missing successor_id, unknown predecessor, or self-supersedence. The `x-supersedence-source` request header threads through to the audit log so UI calls record `source: "ui"` and CLI calls record `source: "cli"` without forking the storage layer.

**Storage-layer overwrite fix (surfaced by live smoke).** `SqliteSessionStore.markSuperseded` now deletes any prior `(*, predecessor, 'supersedes')` edge before inserting the new one. Before the fix, marking sess_A superseded first by sess_B and then by sess_C left the sess_B edge orphaned — sess_A reported `supersededBy: sess_C` but sess_B still claimed `supersedes: [sess_A]`. The audit log preserves the full decision history; the `session_edges` graph now reflects current state only. Regression test added in `tests/integration/mcp.test.ts`.

**CLI — `nlm supersede`.** `src/cli/supersede.ts` ships `executeSupersede()` as a pure async function with injected IO, plus a `runSupersedeCommand` wrapper that wires the real Sqlite store + Ollama embedder + @clack/prompts. Two interactive search prompts (predecessor, successor) using the existing recall layer + per-result label/date/runtime/id display, optional reason, confirmation prompt showing labels not UUIDs. Three usage modes:
- Fully interactive: `nlm supersede`
- Direct args: `nlm supersede <pred> <succ> -y -r "reason"` skips all prompts
- Partial: one id given, other prompted

QA-identified blockers fixed in this release:
- **B1 — silent overwrite of a prior link** caught and required explicit `confirmOverwrite` ack showing the prior successor's label. `--yes` bypasses (scripted-flow escape hatch).
- **B2 — noop check ordering** — `alreadyLinked` now short-circuits *before* `markSuperseded` fires, so the noop path skips the write entirely (test uses a store Proxy to assert markSuperseded is never called in the noop branch).
- **B3 — confirm dialog showed UUIDs** — `formatHandle()` now renders `"<label>" (YYYY-MM-DD)` so the user confirms against the same text they searched.
- **Migration-dir path bug** — `new URL(...).pathname` percent-encoded the space in `"Coding Projects/"`. Switched to `fileURLToPath()`. Caught by the live smoke; would have broken on every dev machine with spaces in a parent dir.

**UI — SessionDrawer overflow menu + SupersedePalette modal.** `src/ui/components/SupersedePalette.tsx` (new) opens from a `⋯` menu in the drawer header. Search input wires to `/api/recall?mode=hybrid&limit=8` with 200ms debounce, ↑/↓ navigation, Enter to pick. Optional reason field on the picked state. POSTs to the new HTTP endpoint with `x-supersedence-source: ui`. Drawer paints the supersedence banner optimistically on `onMarked` before the canonical refresh round-trips.

QA-identified blockers fixed in this release:
- **B4 — Esc closed both palette and drawer** — palette handler attached to dialog ref (not window) and calls `stopPropagation()`; drawer's window-level handler guards with `if (paletteOpen) return`.
- **B5 — palette rows not keyboard-reachable** — rows now have `tabIndex={0}`, `role="option"`, `aria-selected`, and an Enter/Space handler. Tab can land on a specific row without ↑/↓ on the input.
- **B6 — no focus trap** — `useEffect` collects focusables via the dialog ref and traps Tab/Shift-Tab inside the modal.
- **B7 — no listbox semantics** — search input is `role="combobox"` with `aria-controls`, `aria-expanded`, `aria-activedescendant`. List is `role="listbox"`. AT users get proper navigation feedback.

Cheap wins also in this release:
- **B8** — `.palette-row` grid widened to `80px 110px minmax(0,1fr) minmax(80px,160px)`, `.palette-row-id` gets ellipsis + right-align so UUID v7 strings don't squeeze the label column.
- **B9** — `onMarked(successorId)` optimistically sets `session.status = "superseded"` + `supersededBy = successorId` before the reload, so the user sees their change immediately.
- **B10** — new `useEffect([sessionId])` resets `paletteOpen` + `menuOpen` on session navigation; transient palette state can't leak across the ←/→ navigation.
- **B11** — `appendSupersedence` still doesn't throw, but failures now write one warning line to stderr instead of being silently swallowed. Test uses a file-as-parent-dir trick to deterministically force the mkdir failure.

**Tests.** 22 new tests across 4 files: 8 CLI integration tests in `tests/integration/cli-supersede.test.ts` (blocker coverage + happy path + unknown-id branches), 6 HTTP endpoint tests in `tests/integration/http.test.ts`, 4 supersedence-log unit tests including the B11 stderr-on-failure case, 1 MCP regression for the orphan-edge fix, plus existing assertions tightened. Full suite: 649/649.

**Live smoke verified end-to-end** on an isolated temp DB with three seeded sessions: CLI happy path → noop on re-mark → overwrite warning in interactive mode → HTTP POST → audit-log inspection confirming `source: cli` and `source: ui` separation. Two real bugs surfaced and fixed during smoke.

**State.** v0.5.8 candidate. The launch demo's leg-2 beat ("operator edits the timeline") is now humanable from both the terminal and the UI, not just programmatically via MCP. Next: task #211 (record the demo video, now unblocked at the UX level too), #210 still pending in parallel.


## 2026-05-30 — `mark_superseded` MCP tool (task #209) — opens leg-2 write surface

Shipped the post-hoc supersedence write path. Until now, leg 2 of the README thesis ("editable timeline") was read-complete but write-incomplete: `get_session` enrichment, `get_fact_history`, and the River visualization all worked, but the only way to mark an existing session superseded was at-ingest time (when the new session declared its predecessor) or via direct SQLite mutation. The audit synthesis from earlier today flagged this as the leg with the weakest UX — and the one the `vs Alternatives` matrix leans on hardest as the differentiator. The launch demo can now record the beat where the operator edits the timeline.

**New MCP tool `mark_superseded`.** Input: `{ predecessor_id, successor_id, reason? }`. Validates both ids exist and that they differ, then atomically inserts a `session_edges (successor_id, predecessor_id, 'supersedes')` row and flips the predecessor's `sessions.status` to `'superseded'`. Idempotent — re-marking the same pair is a no-op (INSERT OR IGNORE + status update both already idempotent). Annotated `idempotentHint: true`, `destructiveHint: false` so MCP clients can call it eagerly.

**Port + storage.** Added `markSuperseded(predecessorId, successorId)` to the `SessionStore` port. Implemented in `SqliteSessionStore` as a single `db.transaction()` so either both writes (edge + status flip) land or neither does. Throws on missing ids with a message naming which one was missing, so MCP error tool-results are diagnostic.

**Audit log.** New `src/core/storage/supersedence-log.ts` writes one JSONL line per `mark_superseded` call to `~/.nlm/supersedence-log.jsonl` (overridable via `NLM_SUPERSEDENCE_LOG`). Schema mirrors citation-log: `ts`, `predecessor_id`, `successor_id`, optional `reason`, `source`. Telemetry-style — wrapped in try/catch so a write failure can't break the MCP call path. Atomic-on-ingest supersedence is not logged here (the edge itself is provenance); only operator-driven post-hoc mutations need an audit trail.

**Tests.** Five new integration tests in `tests/integration/mcp.test.ts` covering: happy path (status flips, edge appears in enriched `supersededBy`), idempotency (re-marking doesn't dup the edge), unknown predecessor, unknown successor, self-supersedence rejection. `NLM_SUPERSEDENCE_LOG` is redirected into the test tmpdir per case so the host log isn't touched. The `InMemoryStore` test double in `recall-service.test.ts` got a no-op `markSuperseded` to satisfy the port. Full suite: 626/626.

**Docs.** Updated `docs/supersedence.md` to replace the "intentionally no `mark_superseded` MCP tool" paragraph with the actual tool semantics, audit-log path, and the distinction between ingest-time vs operator-driven supersedence. Updated the MCP Tools table in the README. Bumped `SERVER_VERSION` in `src/mcp/server.ts` to `0.5.7`.

**State.** v0.5.7 candidate. Legs 1 (Codex from #208) and 2 (write path from #209) both shipped. Next: task #211 — record the side-by-side terminal demo video (now unblocked). #210 (daily SQLite backup, P1) still pending in parallel.

## 2026-05-30 — Codex TranscriptAdapter (task #208) — closes leg-1 credibility gap

Shipped the Codex adapter so the README's "9 adapters" claim now matches reality. Prior to this, `connectCodex` wired the MCP server only — Codex sessions were never indexed, so anyone trying Codex post-install would find no recall hits on their first run. The thesis-coherence audit (vault Ventures/nlm-memory/learnings.md, 2026-05-30) called this out as the single largest leg-1 credibility risk.

**New `src/core/adapters/codex.ts`.** `CodexAdapter implements TranscriptAdapter`, runtime `codex/1.0`, transcript kind `codex-jsonl`. Walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` recursively (mirrors codex's on-disk layout — discover handles arbitrary nesting via depth-first walk). Sessions filter by mtime via `DiscoverOptions.since` like the other adapters.

**Conversation extraction strategy.** Codex stores the same turn twice in different shapes — once as `response_item` with role+content[], and once as `event_msg` (`user_message`/`agent_message`) with a plain string. Picked `event_msg` as the primary source because it sidesteps the AGENTS.md envelope that codex injects as a synthetic `response_item.message` with role=user on session start. No regex stripping needed — the developer role and the permissions preamble simply never enter the turn stream. Tool calls come from `response_item` (`function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`) and surface as inline `[tool_use: <name>]` / `[tool_result: <preview>]` markers (preview cap 240 chars, mirroring claude-code). Reasoning, web_search_call, token_count, turn_context, and task lifecycle events are intentionally dropped.

**Registry wiring.**
- `SourceKind` in `src/core/sources/source-registry.ts` now includes `"codex"`. New seed preset points at `~/.codex/sessions` (overridable via `NLM_CODEX_SESSIONS_PATH`), `enabled` mirrors path existence.
- `adapterFromSource()` in `src/core/adapters/from-source.ts` routes `codex` to `CodexAdapter`.
- `VALID_SOURCE_KINDS` in `src/http/app.ts` updated so the `POST /api/sources` route accepts `kind: "codex"`.
- UI registry (`src/ui/lib/registries.ts`) gets the `codex` entry across `SourceKind`, `SOURCE_KINDS`, `SOURCE_KIND_LABEL`, and `SOURCE_PRESETS` so the "Add source" wizard offers it as a one-click preset.

**Migration 016.** `migrations/016_sources_codex.sql` rebuilds the `sources` table with `codex` added to the `kind` CHECK constraint (SQLite doesn't permit in-place CHECK edits — standard rename → recreate → copy → drop dance).

**Tests.** `tests/fixtures/codex/{standard_session,tool_heavy,short}.jsonl` plus `tests/unit/core/adapters/codex.test.ts` (12 tests covering discover walk, mtime filter, missing-dir, empty-file, parse with UUID extraction, developer-role suppression, tool marker rendering, label derivation, and meta-only file → null). `tests/integration/source-registry.test.ts` updated for the new preset count (8 → 9, codex slotted between claude-code and hermes). Full suite: 621/621 green.

**Live smoke.** Adapter pointed at `~/.codex/sessions` discovers 43 rollouts and parses the latest into `codex_019e69ff-c83c-7b42-a7ce-8d299e8ec092` with the correct cwd, turn count, and label. No code path needs the AGENTS.md envelope filter — confirmed by parsing several real sessions and not seeing any system-prompt leakage in the transcript text.

**State.** v0.5.7 candidate. Next: task #209 `mark_superseded` MCP tool (leg 2 write surface — required before the launch demo can prove the editable-timeline differentiator).

## 2026-05-29 — v0.5.4: SVG banner + docs/ (supersedence, hooks, recall methodology)

Visual + docs patch on top of v0.5.3. No code changes; surface and documentation density only.

**SVG banner.** New `assets/banner-dark.svg` + `assets/banner-light.svg` rendered via `<picture>` in the README so GitHub/npm/IDE previews switch automatically by theme. Visual: 14-dot session timeline on top with a curved arrow looping back from a newer (filled) session to a hollow "superseded" one — encodes the editable-timeline differentiator in a glance. Wordmark "nlm-memory" with a teal accent on the hyphen + the standard tagline + a tertiary "session-grained recall · editable timeline · cross-runtime" line. All ui-monospace, no embedded fonts, ~3KB each. Added `assets` to the `files` whitelist so the SVGs ship with the npm tarball.

**`docs/` folder.** Three deep-dive pages, GitHub-only (not shipped to npm):

- `docs/supersedence.md` — the editable timeline. Documents the four session statuses (`active`/`idle`/`closed` derived from transcript mtime; `superseded` persisted and overriding); how supersedence is recorded atomically on insert; why superseded sessions still surface in recall (audit trail preservation); the entity-level retire/snooze/label overlay as separate from session status; why there's no `mark_superseded` MCP tool yet and the rationale.
- `docs/hooks.md` — full hook lifecycle. The five hooks (UserPromptSubmit, SessionStart, Stop, PreCompact, SubagentStart) with what each does, when it fires, and what it outputs. Selection constants (`PER_FIRE_CAP=3`, `PER_CONVERSATION_CAP=10`, `RECALL_TIMEOUT_MS=2000`) pulled live from `src/hook/prompt-recall-hook.ts`. Logging surface (hook-log, citation-log, useful-hit-log, query-log, subagent-log) with override env vars. The pointer-block format with the actual three-line shape callers see. Mode toggle (`live`/`shadow`), Bearer auth flow, fail-open semantics, the digest liveness canary.
- `docs/methodology-recall-baseline.md` — where the 97.2% R@5 figure comes from. Distinguishes the LongMemEval-S public-dataset harness (reproducible by anyone via `node dist/scripts/longmemeval/run-harness.js`) from the 14-month personal-corpus baseline (not directly reproducible but methodology is documented). Field-weighting table (entity-exact ×4, label ×3, decision ×2, summary ×1, phrase-bonus +5) from `match-fields.ts`. The "without classifier output" failure mode is called out so the number isn't misread.

**README accuracy fix.** The differentiator bullet previously said "sessions can be superseded, retired, or marked aborted" — but there's no `aborted` or `retired` *session* status in code (only `superseded`; retirement is an entity-overlay action). Tightened to "sessions can be superseded by newer ones; entities can be retired." Linked the new `docs/supersedence.md` from the same line.

**Tests:** 612/612 (no code changes).


## 2026-05-29 — v0.5.3: GitHub page polish (README density, LICENSE fix, repo metadata)

Cosmetic + presentation patch. No behavior changes — the public-facing surface (npm registry page, GitHub repo header, README) is now appropriate for general-public discovery.

**README rewrite.** Restructured from a 9-section narrative into a denser, table-heavy reference that mirrors the layout of larger memory-OS projects (agentmemory et al.). New structure: badge row → nav anchors → 3-bullet differentiators → install/quickstart → runtimes table (9 adapters with connect commands + hook surface) → hooks table (5 hooks × what NLM does + mode) → MCP tools table (5 tools) → REST API table (~14 endpoints with auth requirements) → digest section → UI page table → ASCII pipeline diagram → env-vars table (15+ vars with defaults) → ports table → security → upgrade → comparison matrix (vs mem0, Letta, CLAUDE.md across 9 dimensions) → development. Every table is grounded in source — endpoint list pulled from `src/http/app.ts`, env vars from `grep process.env`, tools from `server.registerTool` call sites.

**LICENSE fixed.** Replaced the truncated 151-line LICENSE with the canonical 202-line Apache 2.0 text from apache.org. GitHub had been showing `NOASSERTION` because its license detector requires the full standard text; now it correctly identifies as Apache-2.0 and the license badge on the GitHub repo header renders.

**GitHub repo metadata.** Description rewritten to actually describe the project ("Local-first non-linear memory OS for AI operators. One index across Claude Code, Codex, Cursor, Windsurf, Hermes, OpenCode, Aider, pi, and more — with an editable timeline."). Homepage points at the npm page. 17 topics set (ai, memory, mcp, claude-code, codex, cursor, windsurf, hermes, opencode, aider, local-first, session-memory, recall, typescript, sqlite, ollama, deepseek) — was previously empty.

**Tests:** 612/612 (no code changes).

## 2026-05-29 — v0.5.2: `nlm digest` — daily activity push, optional Telegram delivery

Promoted a personal cron script into a first-class NLM command. Anyone who installs NLM can now wire a one-line cron entry to get a morning recall summary, with built-in hook-liveness alerting.

**`nlm digest`** prints a daily-activity report from the running daemon:
- 24-hour real-traffic volume with per-source breakdown (probes filtered against six known test patterns)
- 7-day hit_rate + real/total split
- 7-day useful_hit_rate (or "pending" when `nlm useful-scan` hasn't been run)
- Top 5 queries from the 24h slice
- A `WARN hook silent` alert when Claude Code ran yesterday but no `mode:live` fires were logged — the load-bearing canary for post-install hook drift (node upgrades, settings.json hand-edits, dist moves silently break the hook; this catches them within a day)

**`--telegram`** flag POSTs to Telegram via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars. When the daemon is unreachable, the Telegram path still fires — posts a "daemon unreachable at …" alert instead of failing silently, because the cron user is specifically watching for that signal.

**Architecture.** Split into pure + adapter to keep it testable:
- `src/core/digest/compose.ts` — pure formatter (stats + recent → digest text); no I/O
- `src/core/digest/hook-liveness.ts` — pure canary (sessions + hook log → alert string | null)
- `src/cli/digest.ts` — HTTP fetch + Telegram POST + orchestration; talks to the daemon over loopback so it works regardless of where the daemon is running

Bearer auth handled via the existing `hookAuthHeaders()` so the new `/api/*` gate doesn't break the digest path.

**Tests:** 612/612 passing (+11 new unit tests: 6 compose cases, 5 hook-liveness cases including window-boundary, shadow-mode-doesn't-count, missing-log-file).

## 2026-05-29 — v0.5.1: public-launch ship readiness

**Goal:** close the gap between "works for me" and "safe to share with strangers" before opening the rollout to general public. Audit-driven patch — no new behavior, but the package shape and metadata are now appropriate for an npm-registry public listing.

**Personal data removed from published surface.** `scripts/nlm-daily-digest.{sh,py}` and `scripts/deepseek-probe.mjs` were Edward's local cron + probe scripts with hardcoded `/Users/echalupa/...` paths. They shipped in v0.5.0 (no `files` whitelist) so every `npm install` user saw the absolute paths and the existence of unrelated Whtnxt workspaces. Moved to private storage outside the repo and `git rm`'d.

**`package.json` whitelist.** Added `files: ["dist", "plugin", "LICENSE", "README.md"]`. Tarball drops from 500 → 264 files, 747 kB → 351 kB packed (3.0 MB → 1.4 MB unpacked). Tests, fixtures, source, and dev configs no longer ship to users.

**Public-repo metadata.** Added `repository`, `homepage`, `bugs`, and `keywords` so npm and GitHub registry pages render correctly. The npm page previously had blank "Report Issues" / "Repository" fields.

**Version reporting fixed in two more places.** v0.5.0 fixed `/api/health` to read from `package.json` but missed the CLI flag — `nlm --version` reported `0.3.0` regardless of installed version. Both endpoints now share the same dynamic source.

**MCP `get_session` supersedence enrichment.** Response now includes `{id, label, summary}` for each `supersedes` / `supersededBy` entry instead of just opaque IDs. AI callers chasing a corrected fact no longer need a second round-trip to read the predecessor's label.

**River UI: superseded-session lane visualization.** Sessions in `superseded` status are now tracked separately from active ones and rendered with reduced opacity. Entities that exist only as superseded history still appear in the lane list instead of vanishing.

**Public repo polish.** New `SECURITY.md` (responsible disclosure + threat model), `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}` so issues land structured. README rewritten: install command corrected to `npm install -g nlm-memory`, Linux + Windows platforms documented, `nlm setup` wizard explained, hook system has a dedicated section, `NLM_MCP_TOKEN` mentioned, upgrade-from-v0.4.x callout added, new Security section.

**Tests:** 601/601 passing.


## 2026-05-29 — Search rebuild, Thread runtime filters, SessionDrawer nav, pagination

**Search page full rewrite** — replaced a hard-capped 50-result list with a production-grade search UI:
- Pagination: `PAGE_SIZE_OPTIONS = [10, 25, 50, 100]`, default 25, prev/next/first/last controls
- Filter chips: runtime, status, entity (top 12 + overflow `<select>`), sort mode (relevance/recent)
- Match snippets: 120-char window anchored on first token hit, `<mark>` highlighting, XSS-safe via HTML escape before regex
- Field-origin live-tag: shows which field (label/entity/decision/open/summary) matched
- Score weights: label×3, entity-exact×4, entity-substring×2, decision×2, open×2, summary×1, phrase-bonus+5
- Sticky search header, "clear filters" button, `anyFilterActive` empty-state hint
- SessionDrawer integrated; prev/next from paged slice

**Thread page** — runtime/agent filter chips:
- `EntityPicker` now has: search input, sort chips (most-active/least-active/a-z/z-a), pagination [24,48,96] default 48, runtime filter chips
- `ThreadSessionList` adds runtime filter chip row (only rendered when `threadRuntimes.length > 1`)
- Bug fixed: runtime filter reset now depends on `entity` string prop, not `thread` object reference (was resetting on sort)

**SessionDrawer** — keyboard and button navigation:
- `prevSessionId` / `nextSessionId` props; ← / → arrow key nav
- Chevron SVG buttons in drawer header

**UI/UX review loop** — spec-first pass (Opus) before developer subagent; review pass after. Caught 3 runtime bugs: hooks ordering, Vitest env detection (`VITEST=1` not `"true"`), CSS currentColor misuse on dot-pulse.

**Tests:** 601/601 passing.

**Next:** Supersedence visible in River + `get_session` MCP response (editable timeline moat needs to be visible in the UI).

## 2026-05-29 — Workspace coverage, global DB mode, CLI connect/disconnect (9503042)

**CursorAdapter expansion** — three-format coverage via prefix-based dispatch:
- `cr_` — global `cursorDiskKV` (current, v1.x+; already shipped)
- `crw_` — workspace `ItemTable` `composer.composerData` → `allComposers[]` (v0.43–v1.x migration artifact)
- `crc_` — workspace `ItemTable` `chatdata` tabs (all versions)

`parseSession()` routes by prefix; `workspaceStorageDir()` derived from global DB path parent-of-parent so no extra config needed. `discover()` deduplicates across global + all workspace DBs via a `seen` Set.

**WindsurfAdapter expansion** — global DB agent/flow sessions (`wsg_` prefix):
- Tries `cursorDiskKV` first (`composerData:*`, `agentData:*`, `flowData:*`); falls back to `ItemTable` LIKE query on `%agent%`/`%flow%`/`%cascade%` keys when `cursorDiskKV` absent
- `since` filter bug fixed: `lastSendTime=0` previously matched `0 < cutoff` and was filtered out; guard changed to `ts > 0 && ts < cutoff` so zero-timestamps (unknown age) are always included

**All discover() IDs now prefixed** — prefix is the routing token, not decoration. Legacy unprefixed IDs still accepted in `parseSession()` via fallthrough.

**CLI commands wired** — `nlm connect cursor`, `nlm connect windsurf`, `nlm disconnect cursor`, `nlm disconnect windsurf`. Each opens the NLM `SqliteSessionStore`, creates a `SourceRegistry`, calls the appropriate install function, prints a one-line report. Supports `--dry-run` and `--db-path`/`--user-dir` overrides. `exactOptionalPropertyTypes` fix: optional CLI option values spread conditionally (`...(opts.x ? { x: opts.x } : {})`).

**Tests** — 596/596 passing (up from 543). Adapter tests grew from 39 to 53. Added workspace composer (`crw_`), chat tab (`crc_`), Windsurf global DB (`wsg_`), since=0 fix, and since-filter for all three tab types.

**State:** v0.4.2 on npm (no bump this session — workspace+CLI work is additive on 0.4.2). 596 tests green. Commit `9503042`.

**Next:** Dedicated UI session — supersedence visible in River + `get_session` MCP response (editable timeline moat needs to be visible).


## 2026-05-29 — Cursor adapter + Windsurf adapter (NocoDB #182, #183)

**CursorAdapter** (`src/core/adapters/cursor.ts`)

Reads Cursor AI composer sessions from `globalStorage/state.vscdb` (macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`). Schema: `cursorDiskKV` key-value table. Session = one `composerData:<composerId>` entry. Messages read from inline `conversation[]` (v1.x) or `bubbleId:<composerId>:*` separate storage (v1.5+). Type `1` = user, `2` = assistant. Session ID prefix `cr_`. Env override: `NLM_CURSOR_DB_PATH`. Migration 014 adds `'cursor'` to the `sources.kind` CHECK constraint.

**WindsurfAdapter** (`src/core/adapters/windsurf.ts`)

Reads Windsurf (Codeium Cascade) chat sessions from workspace-scoped SQLite DBs in `<UserDir>/workspaceStorage/<hash>/state.vscdb`. Schema: `ItemTable`, key `workbench.panel.aichat.view.aichat.chatdata`, value JSON with `tabs[]`. Each tab = one session. Bubble role: `type: 'user'`→user, `type: 'ai'`→assistant; prefers `rawText` over `text`. Session ID prefix `ws_`. `pathOrUrl` = User directory (adapter discovers all workspace DBs by scanning). Env override: `NLM_WINDSURF_USER_DIR`. Migration 015 adds `'windsurf'` to the constraint.

**Wiring:**
- `from-source.ts`: `cursor` and `windsurf` cases added
- `source-registry.ts`: `SourceKind` extended; `seedDefaults()` now seeds 8 presets (cursor + windsurf auto-enabled if their paths exist)
- `tests/integration/source-registry.test.ts`: preset assertions updated to 8

**State:** 582 tests passing (was 543, +39 new). Build clean, typecheck clean.

**Next:** Training pipeline (#185, deferred until `nlm useful-scan --stats` shows >50 useful-hit-log positives). Consider bumping to v0.5.0 after `nlm connect cursor` CLI wiring.

## 2026-05-29 — Credential file permissions hardening (v0.4.2)

**Security fix (automated plugin review catch):** `src/install/ollama.ts` `writeClassifierConfig()` now creates `~/.nlm` with `mode: 0o700` and writes `.env` with `mode: 0o600`. Added `chmodSync` on both dir and file to repair permissions on pre-existing installations. This was flagged as HIGH by the `security-guidance@claude-code-plugins` stop hook after the manual audit and peer review had both noted the `644` file issue but the prior session ended before fixing it. Published as `nlm-memory@0.4.2`.

**State:** 543 tests passing. GitHub tag `v0.4.2` pushed.

**Next:** Cursor adapter (NocoDB task #182), Windsurf adapter (#183). Training pipeline (#185) deferred until >50 useful hits in `useful-hit-log.jsonl`.

## 2026-05-29 — Security hardening: bind address, timing-safe auth, backup/restore gate

**Changes:**
- `src/cli/nlm.ts`: `serve()` now passes `hostname: "127.0.0.1"` — daemon no longer listens on all interfaces. Verified: `lsof` shows `127.0.0.1:3940` only.
- `src/http/app.ts`: `/mcp` bearer token comparison replaced with `timingSafeEqual` (was `!==`).
- `src/http/app.ts`: `/api/data/backup` and `/api/data/restore` now require `Authorization: Bearer <NLM_MCP_TOKEN>` when that env var is set. When unset (local-only use), the `127.0.0.1` bind is the guard.
- Import: `timingSafeEqual` from `node:crypto` added.

**Findings that prompted this (peer-reviewed audit 2026-05-29):**
- MEDIUM: `0.0.0.0` binding exposed all HTTP endpoints to LAN — root finding that amplified everything else.
- MEDIUM: backup/restore unauthenticated — full DB exfiltration from LAN with one HTTP call (peer reviewer caught this; primary auditor missed).
- LOW: non-timing-safe bearer comparison on `/mcp`.

**State:** 543 tests passing (no regressions). Daemon reloaded; bind address confirmed.

**Next:** Cursor adapter (NocoDB task #182), Windsurf adapter (#183). Deferred: training pipeline (#185, needs >50 useful hits).

## 2026-05-28 — Scheduler failure backoff (a5c29b0)

**Bug fixed: infinite classify retry storm**

Session `517ca931.jsonl` (230KB, Whtnxt Agent project) was failing DeepSeek classification every 30-min tick because no `adapter_state` row was ever written on failure — so `scanOnce` saw a "new" file every tick. The daemon log showed hundreds of `[scheduler] classifier error for cc_517ca931 — skipping` with no error detail.

Migration 013 adds `failure_count INTEGER DEFAULT 0` to `adapter_state`. `recordFailed()` increments `failure_count` and writes the current `file_size`. `scanOnce` skips files whose size hasn't changed, whether clean or failed — so any stuck file stops retrying until new content arrives. When the file grows, `failure_count` resets to 0.

The scheduler now logs the actual error message and a `failure N/M` counter (e.g. `error: LLM unreachable: deepseek for cc_517ca931 (failure 1/3)`). The real error was `LLM unreachable: deepseek` — now diagnosable. 2 new integration tests; 543 total passing.

**State:** daemon reloaded, migration applied, first retry logged correctly. Session `517ca931` will hit ceiling at failure 3/3 and stop.

**Outstanding:** npm publish v0.4.0 (needs `npm login` in terminal). Scheduler (Phase D) is already fully implemented in `nlm start` — confirm via NocoDB task #184 whether anything remains scoped there.

## 2026-05-28 — Aider adapter + useful-scan cron + v0.4.0 release (ece591a, a222f44, 708f49d)

Three items shipped in this session.

**Aider TranscriptAdapter (ece591a)**

`AiderAdapter` reads `.aider.chat.history.md` (or `$AIDER_CHAT_HISTORY_FILE`). A single file may contain multiple sessions, each opened by a `# aider chat started at YYYY-MM-DD HH:MM:SS` header. User turns are H4 headings (`#### ...`); assistant responses are plain text; blockquote lines (`> ...`) become `[tool_action: ...]` summaries. Session IDs derive from the header timestamp as `ai_YYYYMMDD_HHMMSS`. `endedAt` uses the next session's `startedAt` when available (no per-turn timestamps in markdown). Migration `012_sources_aider.sql` adds `'aider'` to the `sources.kind` CHECK constraint. `seedDefaults()` now seeds 6 presets. 21 new unit tests; 541 total pass.

**useful-scan cron wiring (a222f44)**

`nlm-daily-digest.sh` now calls `nlm useful-scan --days 1` before the Python stats fetch so `useful_hit_rate` is populated in the Telegram digest instead of showing "pending". Scan output goes to `logs/daily-digest/useful-scan.log`; `|| true` keeps the digest alive on scan failure. Dry-run confirmed: 161 recalls scanned, 0% useful (accurate — no `cite_session` calls yet).

**v0.4.0 (708f49d)**

Version bump and `git tag v0.4.0`. npm publish requires `npm login` — tag is set, publish when authenticated.

**State:** build clean, 541 tests green. Outstanding: npm publish (needs `npm login`); C2 Aider and useful-scan cron are now complete.

**Next:** README is rewritten. No outstanding P1s remaining. Consider: npm publish, prose-citation soft labels (deferred), or new feature work.

## 2026-05-28 — HermesAgentAdapter: TranscriptAdapter for NousResearch Hermes Agent (7b9074b)

`src/core/adapters/hermes-agent.ts` — reads `~/.hermes/state.db` (WAL mode, schema v11). Extracts user/assistant/tool turns; tool calls in assistant messages summarized as `[tool_use: <name>]`; tool-role messages summarized as `[tool_result: <name>: <preview>]`; system messages skipped. Label from session `title` field, fallback to first user turn. DB path overridable via `NLM_HERMES_AGENT_DB_PATH` or `HERMES_HOME`.

**Migration 011** (`migrations/011_sources_hermes_agent.sql`) adds `'hermes-agent'` to the `sources.kind` CHECK constraint (same rename-recreate-copy pattern as migration 010).

**Source registry:** `SourceKind` extended; `seedDefaults()` now seeds 5 presets (hermes-agent inserted between hermes and opencode, auto-enabled if state.db exists).

**`from-source.ts`:** `'hermes-agent'` case added, delegates to `HermesAgentAdapter`.

**Tests: 520 pass** (was 501, +19 new in `tests/unit/core/adapters/hermes-agent.test.ts`). `source-registry.test.ts` updated for 5 presets. Build clean, typecheck clean.

**State:** NousResearch Hermes Agent is now fully integrated — plugin hooks (pre/post-turn, session lifecycle) from the previous session + transcript indexing from this session. End-to-end: sessions indexed in SQLite → recalled by the daemon → injected into Hermes Agent via the Python plugin.

**Next:** C2 Aider adapter; B3 extract-triples improvements.

## 2026-05-28 — NousResearch Hermes adapter + README rewrite

**README rewrite**

Lead with the three moats (cross-runtime reach, editable timeline, 97.2% R@5). Dropped "self-improving accuracy" framing. Added OpenCode to the shipped runtime list. Added `nlm connect hermes-agent` to the install table.

**NousResearch Hermes Agent plugin (#165)**

Python plugin for NousResearch Hermes Agent's `plugin.yaml` lifecycle hook system. Covers all 6 events the plugin system exposes.

New files:
- `plugin-hermes-agent/plugin.yaml` — manifest (`kind: memory`, 6 hooks declared)
- `plugin-hermes-agent/__init__.py` — Python shim; each hook POSTs to the local nlm daemon (stdlib only, no PyPI deps)
- `plugin-hermes-agent/README.md` — install guide

New HTTP endpoints in the nlm daemon:
- `POST /api/hook/hermes-agent/pre-turn` — keyword recall for `pre_llm_call`; updates memo; returns `{"context": str|null}`
- `POST /api/hook/hermes-agent/post-turn` — prose citation detect for `post_llm_call`; logs to citation-log.jsonl
- `POST /api/hook/hermes-agent/session-lifecycle` — clears surfaced-ID memo on end/finalize/reset

New install module: `src/install/hermes-agent.ts` — `connectHermesAgent` / `disconnectHermesAgent` (copies plugin dir to `~/.hermes/plugins/nlm-memory/`, enables via `hermes plugins enable` if available).

CLI: `nlm connect hermes-agent` / `nlm disconnect hermes-agent` added to `src/cli/nlm.ts`.

**Tests: 501 pass** (was 488, +13 new in `tests/integration/hermes-agent-hooks.test.ts`). Build clean, typecheck clean.

**State:** all three hermes-agent endpoints tested end-to-end without a TTY. Python plugin is a thin HTTP shim — no Python test harness needed.

**Next:** transcript adapter for NousResearch Hermes sessions (session files stored in `~/.hermes-agent/sessions/` or equivalent); C2 Aider adapter; B3 extract-triples improvements.

_Older entries archived in CHANGELOG-2026.md_

## 2026-05-28 — C1: OpenCode adapter (SQLite-based, `opencode/1.0`)

OpenCode stores all sessions in a single SQLite DB (`~/Library/Application Support/opencode/opencode.db` on macOS, `$XDG_DATA_HOME/opencode/opencode.db` on Linux) rather than per-session JSONL files. The adapter reads it via `better-sqlite3` in readonly mode, reusing the same `TranscriptAdapter` port as Claude Code, Hermes, and pi.

**What ships**

- `src/core/adapters/opencode.ts` (new) — `OpenCodeAdapter` class. `detect()` checks for the DB file. `discover()` queries `session WHERE time_archived IS NULL` with optional `time_updated >= since` filter. `parseSession(sessionId)` joins the `session`, `message`, and `part` tables: extracts `text` parts (non-ignored) and `tool` parts (summarized as `[tool: <name>]`), skips structural parts (step-start/finish, reasoning, compaction, snapshot, patch, agent, retry). Label comes from `session.title` unless it's `"New session"`, in which case it falls back to the first user turn. `gitBranch` read from `.git/HEAD` in `session.directory`. `sourcePath` is `${dbPath}::${sessionId}`.
- `migrations/010_sources_opencode.sql` (new) — SQLite table-recreate migration to add `"opencode"` to the `sources.kind` CHECK constraint (SQLite does not support `ALTER COLUMN`). Copies existing rows, drops old table, renames new.
- `src/core/adapters/from-source.ts` — `"opencode"` case added to `adapterFromSource` switch.
- `src/core/sources/source-registry.ts` — `SourceKind` union extended; `seedDefaults()` now seeds 4 presets (added OpenCode row, auto-enabled if DB exists).
- `tests/unit/core/adapters/opencode.test.ts` (new) — 15 tests: detect enabled/disabled, discover (all sessions, archived exclusion, since filter, absent DB), parseSession (null for unknown, null for no usable turns, turn count + roles, ignored-part skipping, tool-part summarization, title label, fallback label, sourcePath format, projectDir, absent DB, ISO timestamps), and metadata assertions.
- `tests/integration/source-registry.test.ts` — two assertions updated: "seeds three presets" → "seeds four presets"; kind list updated to include `"opencode"`.

**Architecture note**

The `discover()` / `parseSession()` contract treats session IDs (not file paths) as the identifying string — the interface's `path: string` param is opaque, so this is valid. Users with OpenCode already installed get the source auto-enabled on first `nlm migrate` + daemon restart with no manual configuration.

**Tests: 488 pass** (was 470 before this session). All 57 test files green, build clean.

**Next:** README rewrite (D) — drop "self-improving accuracy" promise; lead with the three moats (editable timeline, cross-runtime MCP reach, 97.2% R@5). Then NousResearch Hermes adapter (#165, P1).

## 2026-05-28 — Code review: HOOK_SCRIPT_MARKERS bug caught and patched (44fec62)

`code-review:code-review` skill run against commits `10c16ac..285fe9e`. One confirmed bug found and fixed: `HOOK_SCRIPT_MARKERS` in `claude-settings.ts` did not include the three Phase 2 hook filenames (`session-start-hook.js`, `pre-compact-hook.js`, `subagent-start-hook.js`). Consequence: `nlm hook uninstall` silently left all three hooks behind; each reinstall appended a duplicate instead of replacing. Live settings had two `SessionStart` NLM entries. Fix: added three filenames to `HOOK_SCRIPT_MARKERS`, updated stale file-level comment, rebuilt, reinstalled. Settings deduplicated (1 entry per event × 6 hooks). 436/436 tests pass. No other confirmed bugs from the review — four lower-confidence items scored below 80 and were not acted on.

**State:** `nlm v0.3.0` installed globally. 6 hooks clean in `~/.claude/settings.json`. Shadow mode live.

**Next:** `nlm useful-scan` CLI (B1 full); C1 OpenCode adapter #180 (P1); B3 extract-triples redesign; tests for `session-start-hook.ts`.

## 2026-05-28 — Deploy v0.3.0: 6 hooks live; cite_session double-count fixed; useful_hit_rate stub; session-start source added

Four commits on main (`976e549` → `d013caf`). All 436 tests green throughout.

1. **B2 double-count fix** (`976e549`): `citation-detect.ts` was re-detecting `cite_session` tool_uses in the Stop hook and writing a second citation log entry. MCP handler already calls `appendCitation()` directly. Fix: skip `cite_session` in Stop hook detector; updated 5 tests in `citation-detect-cite-session.test.ts`.
2. **B1 stub** (`976e549`): added `useful_hit_rate: null` to `StatsResult` + both `recallStats()` return paths. Daily digest shows "pending" cleanly instead of a field-access error. Unblocks schema for future `nlm useful-scan` CLI.
3. **Phase 2 hook wiring** (`becb591`): `ALL_HOOKS` now includes SessionStart, PreCompact, SubagentStart. Version string corrected 0.2.0-dev → 0.3.0.
4. **session-start source** (`d013caf`): `src/hook/session-start-hook.ts` written against current interfaces (stale dist imported `loadSurfacedForBudget` that no longer exists). `ClaudeHookEvent` union extended with `SessionStart` + `SubagentStart`.

**State:** `nlm v0.3.0` installed globally, all 6 hooks active in shadow mode. Live measurement window open.

**Next:** `nlm useful-scan` CLI (B1 full implementation); B3 extract-triples redesign; C1 OpenCode adapter #180.

## 2026-05-28 — D4 thesis pivot: citation moat downgraded permanently; adapter breadth + editable timeline elevated; Phase 0/2/3 engineering landed

Full-day arc on 2026-05-27 producing three clusters of work: a 3-agent audit exposing recall-layer defects, five engineering branches integrated (Phases 0/2/3 of the 90-day plan), and a D4 strategic-pivot decision ending in a permanent thesis revision. The cite_session MCP tool lands on this branch (`phase-1c-cite-tool`) as the last Phase 0 piece.

**D4 thesis pivot (permanent):** citation-trained-reranker moat hypothesis fails on fundamentals (corpus too small at ~3,800 rows/year, cross-operator pooling violates local-first). Citation feedback loop's new role: quality-monitoring only. Three elevated moats: (1) editable timeline/supersedence — schema-level, retrofit-impossible; (2) cross-runtime reach via MCP; (3) passive corpus quality at 97.2% R@5. Adapter breadth elevated to primary workstream.

## 2026-05-28 — B1 full: nlm useful-scan CLI + useful_hit_rate live in GET /api/recall/stats

Shipped the full useful-scan implementation. The `useful_hit_rate: null` stub is now a real ratio backed by `~/.nlm/useful-hit-log.jsonl`.

**What ships**

- `src/core/recall/useful-scan.ts` (new) — batch scanner: reads `~/.nlm/hook-log.jsonl` for entries in the rolling window with `wouldInject.length > 0`, finds each conversation's transcript under `~/.claude/projects/**/<conversationId>.jsonl`, extracts the next 3 assistant turns (timestamp-gated), checks if any surfaced ID appears in those turns (text or tool_use inputs), and writes one entry to `~/.nlm/useful-hit-log.jsonl`. Probe entries filtered out via PROBE_PATTERNS. Idempotent: already-scanned `(ts, conversationId)` keys are skipped. Exports `readUsefulHitRate()` for stats endpoint consumption.
- `src/core/recall/query-log.ts` — `StatsResult.useful_hit_rate` type upgraded from `null` to `number | null`. `recallStats()` now calls `readUsefulHitRate()` and populates the field from the log file. Returns `null` if the log is absent or has no measurable entries in the window.
- `src/cli/nlm.ts` — `nlm useful-scan` command added. Flags: `--days <n>` (default 1), `--dry-run`. Prints scanned/measurable/useful counts and rate to stderr.

**Algorithm**

A recall event is useful when ≥1 of the `wouldInject` IDs appears as a substring in the concatenated text+tool_use inputs of the next 3 assistant turns after the hook fire timestamp. Transcript entries have `timestamp` fields so the 3-turn window is timestamp-gated relative to the hook's `ts`. Events with no matching transcript file record `useful: null` (unmeasurable). Probe entries (matching PROBE_PATTERNS: concurrency probe, test probe, path test, recall test, smoke, cutover) are excluded from the rate entirely.

**Rate in stats endpoint**

`GET /api/recall/stats` now includes the real ratio once `nlm useful-scan` has been run at least once in the reporting window. Before that, it reads `null` (the daily digest cron shows "pending"). The daily cron should call `nlm useful-scan` before hitting the stats endpoint. Rate is `useful / measurable` (entries where useful is `true | false`, not `null`) rounded to 3 decimal places.

**Tests: 462 pass** (up from 436 before this session, +26 new in `tests/unit/core/useful-scan.test.ts`). Tests cover: isProbe patterns, extractAssistantTurnsAfter with fixture transcripts (past-cutoff, limit, content-array blocks, malformed lines), findMatchedId (hit, miss, tool_use JSON, edge cases), scanUsefulHits end-to-end (useful hit, non-useful, null transcript, probe skip, empty wouldInject, stop-hook entry skip, dedup on second run, dry-run no-write), readUsefulHitRate (absent log, all-null, rate computation, window exclusion).

**State:** build clean, all 462 tests green.

**Next:** C1 OpenCode adapter #180 (P1, ~2 weeks); B3 extract-triples redesign; session-start-hook integration tests; README rewrite (D).

## 2026-05-28 — B3 extract-triples.mjs + session-start-hook integration tests (32de0c6)

Two items from the work queue, same commit.

**B3 — `scripts/extract-triples.mjs`**

New training-data extraction script. Joins `~/.nlm/hook-log.jsonl` × `~/.nlm/citation-log.jsonl` × `~/.nlm/canonical.sqlite` to produce `(query, surfaced_id, surfaced_body, label, weight, source)` JSONL rows.

Algorithm:
- **Gold conversations**: any conversation with ≥1 `tool_use` citation is a gold conversation. Only these have confirmed positive signal.
- **Positives** (weight 1.0, source `tool_use`): sessions that appear in both `wouldInject` and the tool_use citation log for the same conversation.
- **Hard negatives** (weight 0.0, source `hard_negative`): sessions in `wouldInject` for a gold conversation but NOT in the citation log. The conversation had a citation elsewhere, so these sessions were genuinely not useful.
- **Prose-only conversations excluded entirely**: prose citation signal is too noisy to treat as gold.
- Dedup by `(conversationId, query, surfaced_id, source)` — repeated hook fires for the same conversation collapse to one row.
- `surfaced_body` fetched from SQLite (readonly). Missing DB or missing row → empty string (non-fatal).

Flags: `--days <n>` (default 30), `--output <path>` (default stdout), `--stats` (counts only, no rows written).

Smoke test against live data: 5 positives, 41 hard negatives, 7 gold conversations, 46/46 with body.

**Missing tests — `tests/integration/session-start-hook.test.ts`**

8 integration tests for `runHook` in `session-start-hook.ts`, parallel to `prompt-recall-hook.test.ts`:
- Shadow mode: logs hook-log entry (gate always "evaluate"), no stdout, no memo write
- Live mode: returns pointer block, writes memo
- Dedup: second fire on same conversationId surfaces only new IDs
- Recall rejection: returns "" gracefully
- Empty hits: returns "" in both modes
- promptPreview in hook-log entry matches the query argument
- Cross-fire memo accumulation (sess_a first fire, sess_b second fire — memo holds both)

**Tests: 470 pass** (was 462, +8 new).

## 2026-05-28 — First-run setup wizard: `nlm setup` cross-platform install

Interactive first-run wizard added (`src/install/setup.ts`) using `@clack/prompts`. Covers runtime detection (Claude Code, Codex, OpenCode, Hermes, pi.dev with auto-detect hints), cross-platform Ollama preflight (brew / curl|sh / winget + server readiness poll), classifier API key (DeepSeek or ollama-offline), DB migrations, macOS LaunchAgent, and per-runtime MCP + hook wiring.

**New modules:**
- `src/install/ollama.ts` — platform-aware install/start/pull, `waitForOllamaServer()` poll loop, `writeClassifierConfig()` for `~/.nlm/.env`
- `src/install/claude-code.ts` — `~/.mcp.json` read/write, `installClaudeCodeHooks()` shared helper
- `src/install/hermes.ts` — `~/.hermes/config.yaml` read/write via `yaml` Document API (preserves user comments; `parse()+stringify()` round-trip destroys them)

**CLI additions:** `nlm setup`, `nlm connect claude-code [--with-hooks] [--dry-run]`, `nlm connect hermes [--dry-run]`, `nlm disconnect claude-code`, `nlm disconnect hermes`.

**Evaluator fixes shipped before closing:** malformed JSON/YAML now throws instead of returning `{}` (was silently destroying all other MCP server configs); Hermes config uses `yaml` Document API not round-trip (preserves user comments); server readiness uses poll loop not fixed sleep; Linux curl|sh shows confirmation before running; API keys stripped of clipboard newlines; Codex connect guards on binary presence; dry-run respects `NLM_HERMES_CONFIG` env override; hook install loop extracted to shared helper.

**Tests: 488 pass.** Build clean.

**Next:** README rewrite — drop "self-improving accuracy" promise, lead with cross-runtime reach + editable timeline + 97.2% R@5. NousResearch Hermes adapter (#165, P1).


# nlm-memory-ts CHANGELOG — Archive (2026)

## 2026-05-24 → 2026-05-25 — Hook hardening, idle backstop, RRF fusion, retrieval strategy

Two-day continuation that closed the silent-failure bug class on the hook path and shipped the first piece of the retrieval-ML catch-up plan.

**Hook install hardening (`9a31b34`, `5baf619`):**
- `nlm hook install` now shell-quotes both paths via `shellQuote()` (single quotes with `'\''` escape) so paths with spaces survive `sh -c` tokenization — closes the #161 root cause.
- After writing settings.json, smoke-tests the wired command via `sh -c` with synthetic `{prompt, session_id}` payload, asserts exit==0 AND that `~/.nlm/hook-log.jsonl` grew. On failure: revert via `removeHook("*")`, print actual stderr + offending command, exit 1.
- `nlm uninstall` re-verifies via `launchctl list` after `bootout` — caught a real macOS launchctl flakiness today (bootout returned errno 5 leaving the daemon alive), printed recovery commands, left the plist in place, exited 1. The old empty `catch {}` would have lied about success.

**SessionEnd hook + atomic install (`064a686`):**
- New `src/hook/session-end-hook.ts` cleans up per-conversation memo files when Claude Code closes a session. Logs to `hook-log.jsonl` with `kind:"session-end"` so the daily liveness check correlates.
- `addHook(path, command, event)` and `removeHook(path, event|"*")` generalized to all six Claude Code hook event names. `isNlmEntry` matches a list of known hook-script filenames so future hooks register cleanly.
- `nlm hook install` walks an `ALL_HOOKS` array, smoke-tests each, reverts all on any failure — atomic install semantics matching #161 principle.

**Daemon memo sweep — the actual SessionEnd backstop (`1e5c6f7`):**
- Claude Code's SessionEnd is best-effort (misses crashes, kill -9, IDE force-close). Without a backstop, memo files at `~/.nlm/hook-state/` accumulate forever. Memo sweep runs every 5 min, deletes any memo whose mtime exceeds the dormant threshold (24h, reusing `build-dataset.ts:357`'s existing active/idle/dormant ladder — no new constant).
- `MemoSweepScheduler` mirrors `ScanScheduler`'s start/stop shape. Wired into `nlm start` unconditionally (runs even with `--no-scheduler`). Timer uses `unref()` so it doesn't keep the event loop alive.
- Architectural payoff: hooks become the fast path, daemon is the correctness backstop. SessionEnd firing is now a latency optimization, not a correctness requirement. Generalizable principle now filed in vault `Operations/what-works/infrastructure.md`.

**Daily-digest hook liveness check (`2e14c6a`):**
- `scripts/nlm-daily-digest.py` now correlates Claude Code sessions started yesterday (from `/api/dataset`) vs `mode=live` hook fires from yesterday (from `~/.nlm/hook-log.jsonl`). If sessions > 0 AND live fires == 0, prepends `⚠️ hook silent: N sessions, 0 live hook fires` to the Telegram digest. Silent when CC wasn't used yesterday (no false positives on Hermes/pi-only days). Verified against real data: yesterday (2026-05-22) had 8 CC sessions and 0 live fires — alert fired correctly, matching the known blackout window. This is the load-bearing liveness check; install-time smoke is courtesy.

**Pointer block names all four MCP tools (`015580d`):**
- Footer now reads `NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).` instead of the previous two-tool reference. Module docstring updated to make the distribution-channel rationale explicit: the pointer block is the only cross-runtime surface for teaching the tool inventory to fresh-install users.

**RRF fusion (`24e115a`) — first retrieval algorithm change:**
- `mergeHybrid` replaced with Reciprocal Rank Fusion (k=60, Cormack et al. 2009). matchScore = Σ 1/(60 + rank) across retrievers. Rank-only fusion is robust to BM25's unbounded scores vs cosine's bounded range. keywordScore/semanticScore preserved as min-max normalized informational values for UI display.
- Hook's `SCORE_THRESHOLD=0` unaffected (RRF scores always positive when a session appears in any leg).
- Updated test expresses RRF semantics; new test demonstrates the core property — agreement across retrievers beats single-leg magnitude even with 100× score gap.

**Strategy / decision-record:**
- Ran `/consensus` on the retrieval-gap question (4 options × 5 dimensions × 4 personas). D (parallel: ship RRF + Stop hook now, harness later) won 3-1; ml-researcher dissented for benchmark-first.
- Critical review surfaced two biases: my prompt framing pre-baked D's strategic-alignment win, and three of four personas shared a "ship fast" mindset. Adopted D **with guardrails**: hard deadline on LongMemEval harness (NocoDB #168, 2026-06-08), explicit decision record acknowledging the methodological tradeoff. Calibration note filed in vault `Skills/consensus.md` for future runs.
- Filed NocoDB #166 (Stop hook → useful_hit_rate + citation training signal), #167 (PreCompact → decisions export), #168 (LongMemEval harness with hard deadline).

**State:**
- Tests: 42 files, 325 pass, zero regressions across the two-day window.
- Builds clean on every commit.
- Daemon redeployed (pid 87530, 39 MB RSS, healthy on :3940) with all of: memo sweep wired, RRF in hybrid path, atomic hook install/uninstall verification.
- Hook log: ~36 entries growing reliably, daily digest will start asserting liveness tomorrow morning.

**Next priorities:**
- #166 Stop hook (1 day) — captures operator citation signal; double-duty as useful_hit_rate metric AND training data for future learned reranker (the real moat play).
- #168 LongMemEval harness (1 day, hard deadline 2026-06-08) — establishes baseline, lets every subsequent algorithm change be measured.
- #167 PreCompact (deferred, lower urgency now that memo sweep + daemon polling cover most data-loss cases).
- Stale-reference cleanup: `fact-recall-service.ts` still uses pre-RRF score blending — consider whether facts should also use RRF.


## 2026-05-23 — Adoption fix: hook unbricked + flipped live; MCP tool descriptions sharpened

Continuation of today's earlier session. Investigation of why agent-side NLM usage was near-zero surfaced two compounding causes — one critical bug and one product design gap.

**Critical bug fix — bricked hook (3-day outage)**
- The `nlm hook install` command writes a settings.json `command` string that contains the unquoted absolute path to `dist/hook/prompt-recall-hook.js`. The user's checkout lives under `/Users/echalupa/Documents/Coding Projects/...` — a path containing a space. Claude Code executes hook commands via `/bin/sh -c`, which tokenizes on whitespace. node received `/Users/echalupa/Documents/Coding` as the script arg and threw module-not-found before any of the hook's own error handling could catch it.
- Detection: hook log file timestamp had not advanced since install (2026-05-20 through 2026-05-23), despite many real prompts. The hook was being invoked every time; node was failing every time; Claude Code's fail-open swallowed the error every time. Three full days of zero recall injections.
- Manual fix today: edited `~/.claude/settings.json` to JSON-escape-quote the script path, and flipped `NLM_HOOK_MODE` from `shadow` to `live` (the original "calibrate for 1-2 weeks then flip" plan is moot when shadow mode never collected any data either).
- Follow-up filed as NocoDB task #161: `nlm hook install` must smoke-test the wired command after writing it (run via `sh -c` with synthetic stdin, assert exit 0 + hook log gains an entry within 2s, otherwise fail loud).
- Root cause documented at `Whtnxt Agent Vault/Operations/Tool Lessons/claude-code-hooks.md`.

**Sharpened MCP tool descriptions (product-level adoption mechanism)**
- `RECALL_DESCRIPTION` — rewritten from suggestive ("use when") to imperative ("CALL THIS FIRST"). Added explicit trigger-phrase taxonomy across four categories: decision/position questions, status/open-thread questions, history/continuity questions, and implicit references (the dangerous case — "that pgvector thing", "the X discussion"). Explicitly names the failure mode this tool exists to prevent (re-derivation, contradicting prior decisions). Adds a single "skip ONLY when" anti-pattern.
- `GET_SESSION_DESCRIPTION` — clarified as the follow-up to `recall_sessions` for verbatim quotes, exact wording, or full reasoning context.
- `RECALL_FACTS_DESCRIPTION` — added concrete trigger phrases ("what port is X on", "who owns Y", "what version of Z"). Strengthened the recall_sessions-vs-recall_facts dichotomy: facts for *answer*, sessions for *conversation*.
- `GET_FACT_HISTORY_DESCRIPTION` — reframed around the editable-timeline differentiator. Connected to NLM's supersedence model explicitly so the description doubles as a product-story carrier.

**Decisions / principles set**
- User-config writes (CLAUDE.md, SOUL.md, agent system prompts) do not ship NLM adoption universally. Every NLM user gets the MCP descriptions automatically via the server binary. Every Claude Code user gets the hook via `nlm hook install`. Anything that requires the user to write or edit their own config does not scale beyond Edward's personal workspace.
- The adoption-mechanism principle going forward: NLM ships behavior *inside* runtime extension points (hooks, tool descriptions, middleware wrappers). NLM does not ask the user to write prompts.

**State:** v0.3.0. Hook is live, path-quoted, verified injecting against real prompts. MCP tool descriptions are now imperative + example-rich + trigger-phrase-explicit; agents using any MCP client (Claude Code, Cursor, Cline, Goose, Windsurf, etc.) get the upgraded prompting for free with no config change. All 293 tests green. Tasks #152, #154 done; #161 added.

**Sources:** Whtnxt Agent orchestrator conversation 2026-05-23 (continuation); hook diagnostic in `~/.nlm/hook-log.jsonl` post-fix; task #161 in NLM NocoDB base `pqq1fk57lhyx43s`; wiki update at `Operations/Tool Lessons/claude-code-hooks.md`.

_Older entries archived in CHANGELOG-2026.md_


## 2026-05-20 — Auto-inject recall hook (task #144, shadow mode)

A Claude Code `UserPromptSubmit` hook that surfaces relevant prior sessions automatically, so read-side recall no longer depends on the agent choosing to call the MCP tool.

**Changes**
- `src/core/hook/` — pure gate (`classifyPrompt`), selection (`selectHits`), pointer rendering (`formatPointerBlock`); file-backed per-conversation memo and JSONL shadow log; Claude `settings.json` editor.
- `src/hook/prompt-recall-hook.ts` — orchestrator. Reads the prompt from stdin, gates it, queries `/api/recall` (`x-recall-source: hook`), dedups against the memo, logs always; in live mode emits a capped pointer block. Every path is fail-open.
- `nlm hook install` / `nlm hook uninstall` — manage the `UserPromptSubmit` entry in `~/.claude/settings.json`. Separate from `nlm install`.

**Decisions**
- Ships in shadow mode (`NLM_HOOK_MODE`, default `shadow`): logs what it would inject, injects nothing. Calibrate the gate against `~/.nlm/hook-log.jsonl` for 1-2 weeks, then flip to `live`.
- Pointer-only payload; each session surfaced at most once per conversation (dedup memo); caps of 3 per fire / 10 per conversation — keeps token cost minimal.
- Complements the MCP server (does not replace it): the hook is push/awareness, the MCP tools are pull/retrieval and the cross-runtime read path.

**State:** v0.3.0. Hook installed in shadow mode; live activation pending the calibration window.

## 2026-05-20 — Post-rename hardening: TOON, shipped dist/, neutral label

Follow-ups after the NLE → NLM rename, all on `main`.

**TOON-encoded MCP responses (`1283367`)** — the MCP server TOON-encodes tool responses when `NLM_FORMAT=toon` is set in its env (JSON otherwise; JSON fallback if `toonEncode` throws). Mirrors the workspace MCP convention via `@toon-format/toon`. Cuts token usage on large recall payloads.

**Shipped prebuilt `dist/` (`a85c8f6`)** — `npm install -g github:…` ran `prepare`→build, but the TS/UI toolchain isn't reliably present during a global git install (`tsc: command not found`). `dist/` is now committed (out of `.gitignore`) and the `prepare` script dropped — the GitHub install is a pure copy, verified with a clean install. Rebuild + commit `dist/` on every `src/` change.

**Neutral LaunchAgent label (`9238b89`)** — `io.whtnxt.nlm-memory` → `com.github.pbmagnet4.nlm-memory`. The old label baked a private namespace into every user's LaunchAgent; reverse-DNS of the repo is the conventional neutral form.

**Version alignment (`c8db590`)** — MCP `serverInfo.version` `0.2.0-dev` → `0.3.0`.

**State:** v0.3.0. Daemon, Claude Code MCP, and Hermes MCP all run the same compiled `dist/cli/nlm.js`. Edward's machine re-installed via `nlm install`, so it is now identical to any OSS install.


## 2026-05-20 — Renamed NLE → NLM (Non-Linear Memory)

**Changes:** Package renamed `nle-memory` → `nlm-memory`; binary `nle` → `nlm`; data directory `~/.nle/` → `~/.nlm/`; env var prefix `NLE_` → `NLM_`; LaunchAgent label `io.whtnxt.nle-memory` → `io.whtnxt.nlm-memory`; CLI entrypoint `src/cli/nle.ts` → `src/cli/nlm.ts`; GitHub repo `nle-memory-ts` → `nlm-memory-ts`.

**Decisions:** "Non-Linear Memory" better reflects the product than the prior name. v0.2.0 (NLE) is left published and intact; this ships as v0.3.0.

**Breaking:** Anyone on v0.2.0 must reinstall: `npm uninstall -g nle-memory && npm install -g github:pbmagnet4/nlm-memory-ts && nlm install`, and update their `.mcp.json` server key + path. Existing data is preserved by moving `~/.nle/` to `~/.nlm/`.

**State:** v0.3.0.

## 2026-05-20 — Recall page: adoption + coverage telemetry surface

**Why**

Phase B.3.1 wired the fact-recall query log and the `/api/recall/facts/stats` endpoint, but nothing in the UI rendered it — the telemetry was readable only by curl. Without a glanceable surface there was no way to answer "is the memory system actually being used," which is the question that motivated the instrumentation in the first place.

**Changes**

- `src/ui/pages/Recall.tsx` (new) — top-level page rendering two telemetry blocks: **Session recall** (`/api/recall/stats`, the human-operator surface — what the orchestrator pulls answering questions about past work) and **Fact recall** (`/api/recall/facts/stats`, the agent surface — structured facts pulled mid-task). Each block: KPI row (queries, hit rate, zero-result count, distinct sources), by-source bars, top queries / top subjects+predicates. 7/30/90-day window selector. Polls every 30s. Empty states distinguish "no log on disk" from "log exists, window empty."
- `App.tsx`, `SideNav.tsx` — `/recall` route + nav item (bar-chart icon, between Search and Settings).
- `styles.css` — `.recall-*` classes; reuses the existing `.bar-item`/`.kpi` system with a widened 140px label column for source/query strings.

**Framing decision**

The page header states plainly that hit rate measures whether recall *returned* something, not whether the agent *used* it. By-source is the adoption signal; hit rate is the coverage signal. Recall→use correlation (a feedback endpoint) was scoped out — it needs agent-side cooperation baked into the MCP tool path and shouldn't be built before adoption data justifies it.

**What the live data shows (30d window, first read)**

- Session recall: 37 queries, 91.9% hit rate — but only 6 of 37 came from `mcp` (real agent sessions); 29 are `http` (UI/curl), plus `smoke` + `cutover-test`.
- Fact recall: 4 queries, 100% hit rate, **0 from `mcp`** — every fact-recall call to date is a manual `http` test. No agent has called `recall_facts` through the MCP tool yet.

Conclusion: coverage is fine, adoption is the gap. The corpus answers when queried; agents just aren't querying — fact recall especially has zero real traffic.

**Next**

- Watch `mcp` source counts over the next week as new agent sessions reconnect with the `recall_facts` tool.
- If `mcp` fact-recall stays at zero, the problem is routing — agents need a stronger prompt-level nudge to call `recall_facts`, not more telemetry.
- Phase 2: Tauri 2 wrapper, first-run wizard, signed installers.

## 2026-05-20 — Backfill B.5 complete: pre-vocab-fix reprocess done

Targeted reprocess of 180 sessions that were classified before the predicate-vocabulary fix (sessions that either had no facts or had facts written under the old open-ended predicate scheme). 150 of 180 produced new facts; 30 skipped at `confidence < 0.6` (low-signal sessions — expected).

**Final corpus state:**
- 7,279 total facts in DB (including superseded); 4,952 current (non-superseded)
- Supersedence fired for sessions that had prior facts — old rows kept, new rows point back via `superseded_by`
- `backfill_facts.state` fully hydrated; resumed cleanly via `--reprocess` flag

**Result:**
Facts written in this pass: 768. All 1,960 ingested sessions now have facts or a documented reason why not (low confidence / no body).

**Next:**
- Phase F live observability (#94) — three-column Pulse UI (Reads, Writes, Decisions)
- #106 CI workflow
- Supersedence B.4: collision-detection in live ingest path (currently only backfill has it)


_Older entries archived in CHANGELOG-2026.md_

## 2026-05-19 — NLM desktop product Phase 0 + UI polish

**Why**

Conversation reframed nle-memory-ts from "Edward's tool" to "OSS desktop product anyone can install" after the triggering question "how should users add runtimes and agents/models?" — the existing answers (write a TypeScript adapter, set env vars) are non-starters for any other user.

**Product decisions locked**

- Name: NLM (Non-Linear Memory) — repo/package keep the `nle-memory` codename, user-facing strings use NLM
- License: MIT — free on GitHub, anyone can fork or vendor
- Distribution: GitHub Releases (skip app stores)
- Pricing: free forever, open source
- Stack: Tauri 2 desktop shell + Vite/React UI + Node daemon sidecar, single-user-per-instance, SQLite on user's disk
- Plan committed at `docs/plans/desktop-product.md`

**Phase 0 — backend architecture changes, 5 tasks shipped end-to-end**

- Task 1 (`847468d`): sources registry. Migration 005, CRUD + seedDefaults bridge from env paths. `/api/sources` endpoints. Boot reads adapters from DB.
- Task 2 (`c07cc6f`): generic JSONL adapter + registry-driven scheduler. `JsonlGenericAdapter` for long-tail tools, `adapterFromSource()` factory. Format-specific adapters (claude-code/hermes/pi) stay as code paths.
- Task 3 (`ac1d695`): providers registry with redacted `api_key` + `getSecret()` daemon accessor. `autoloadEnv()` runs before seedDefaults so DeepSeek bridges under launchd. `/api/providers` endpoints.
- Task 4 (`7228792`): live model discovery. Ollama `/api/tags`, OpenAI/OpenRouter `/v1/models`, hardcoded for DeepSeek/Anthropic. `GET /api/providers/:id/models` + `POST /:id/test`. Verified 9 Ollama models in ~5ms.
- Task 5 (`2bb30ae`): webhook ingest. Migration 007 (`sources.token`), one-time-reveal pattern. `POST /api/ingest` Bearer auth + async classify+store via `ingestSession`. Verified end-to-end.

**UI work alongside Phase 0**

- Skeleton loaders (Pulse / Thread / Labels / SessionDrawer)
- Runtimes card on Pulse with per-runtime heartbeats
- Labels page: Status + Type filters + Sort + pagination
- Classifier hot-swap UI via `ClassifierBox` (no daemon restart)
- Settings header padding standardized; white outline hover on Pulse + River

**State**

- 220/220 tests green
- NocoDB: tasks 132–135 + 137 closed, 138 queued for Phase 1
- Property YAML: `lifecycle_stage` flipped `planned → building`

**Next priorities**

- Phase 1: rewrite Classifier page to consume providers registry, build Sources + Providers settings pages with preset wizard + custom JSONL + webhook (one-time token reveal UX)
- Phase 2: Tauri shell, first-run wizard, signed installers, auto-update
- Phase 3: telemetry, backup/restore, license + landing page, first 5 users

## 2026-05-19 — Phase B.5: backfill-facts one-shot + `nle backfill-facts` CLI

The historical session corpus now has a path to a populated FactStore. Sessions that predate the B.2 ingest write path can be classified after-the-fact in batch, with facts threaded through the same B.4 supersedence and B.3 embedding paths as live ingest.

**Refactor (`src/core/storage/sqlite-session-store.ts`)**

Extracted the fact-ingest block out of `insertSession` into two private methods plus one new public entry point. No behavior change for live ingest; opens the gate for backfill.

- `private applyFactsInTxn(sessionId, factStore, facts)` — sync core (DELETE prior + insertMany + B.4 supersedence loop). Used by both `insertSession` (inside its existing txn) and the new backfill entry (inside its own txn). Runs no txn of its own.
- `private async embedFacts(factStore, facts, embedder)` — best-effort per-fact embedding loop. Shared between live ingest and backfill so the embedding behavior matches.
- `public async insertFactsForSession(sessionId, factStore, facts, embedder?)` — the new Phase B.5 entry. Wraps `applyFactsInTxn` in its own txn, then runs `embedFacts`. The session row must already exist (FK rejects otherwise). Use when adding facts to a session row that's already in the database — i.e. backfill.

**Backfill module (`src/core/facts/backfill-facts.ts`)**

- Walks `sessions` ordered by `started_at ASC`, filtered to rows started before the script's cutoff timestamp (race-free vs. live ingest) and with a non-empty body. By default also excludes sessions that already have facts via `NOT EXISTS (SELECT 1 FROM facts WHERE source_session_id = s.id)` — meaning happy-path "resume" works implicitly without any state file.
- Per session: `classifier.classify(body)` → `extractFacts(...)` → `store.insertFactsForSession(...)`. Per-fact embedding runs as part of `insertFactsForSession` unless `embedder: null`.
- Resumable via JSON state file (default `~/.nle/backfill_facts.state`). The state file matters in two cases: low-confidence sessions that get marked done without writing facts (so re-runs don't keep paying the classifier cost), and `--reprocess` mode where the NOT-EXISTS filter is dropped.
- Fatal-stop on `LLMUnreachableError`: if the embedder/classifier connection is down, halt the whole run instead of burning through the whole corpus failing. Operator fixes Ollama, resumes.
- Options: `from` (id-cutoff for operator-resume), `limit` (batch cap), `dryRun` (count without writing), `reprocess` (re-classify sessions with existing facts), `embedder: null` (skip per-fact embedding for speed), `onProgress` (per-session callback).
- Returns a typed report: `{total, processed, factsWritten, skippedAlreadyDone, skippedExistingFacts, skippedNoBody, skippedLowConfidence, classifyFailures, storageFailures}`.

**CLI (`src/cli/nle.ts`)**

New subcommand:

```
nle backfill-facts [--limit N] [--from <session-id>] [--state <path>]
                   [--dry-run] [--reprocess] [--no-embed] [-v]
```

Wires `buildStack()` so it uses the same classifier + embedder + dbPath as live ingest. `-v` streams per-session progress to stderr; the final JSON report goes to stdout.

**Tests (183 pass total, up from 173)**

`tests/integration/backfill-facts.test.ts` — 10 tests against real SQLite + a scripted fake classifier:

- Writes facts for sessions without any; skips sessions that already have facts.
- Supersedence fires across iterations (B.4 + B.5 composed): earlier session writes Fastify, later writes Hono, `findCurrent` returns Hono, `getHistory` walks both.
- `--dry-run` reports counts without writing facts or touching the state file.
- State file gets written; `--reprocess` re-runs honor it (skipping done ids); non-reprocess re-runs are implicit no-ops via the SQL eligibility filter.
- `--from` skips sessions with id ≤ cutoff.
- `--limit` caps the batch.
- Low-confidence sessions get marked done so a re-run doesn't re-classify them.
- `LLMUnreachableError` halts the run (doesn't burn cycles on every subsequent session).
- Sessions started at or after the cutoff timestamp are excluded (race-safe with live ingest).
- `--reprocess` re-classifies sessions with existing facts — the DELETE+insert pattern in `applyFactsInTxn` wipes the old fact and writes the new one.

**Verification**

- `npx vitest run` → 183/183 pass.
- `npx tsc --noEmit` clean.
- Refactor confirmed non-regressive: all prior 173 tests pass with the extracted helpers, including the 9 B.4 supersedence tests that exercise the same `applyFactsInTxn` code path.

**Next**

Phase B.6 — UI fact-count badge on session digests in the SPA. Cosmetic vs. agent functionality; ships last because agents are the primary consumer.

Phase C still gated on real ingest data showing the closed vocab leaves duplicate clusters.

## 2026-05-19 — Phase B.4: deterministic supersedence on (subject, predicate) collision

The FactStore now self-organizes its chains during ingest. When a new session asserts `(subject, predicate, value)` and a non-superseded fact already exists for that `(subject, predicate)` pair from any other session, the prior fact's `superseded_by` gets pointed at the new fact's id — atomically, inside the same session-ingest transaction. No periodic sweep, no LLM in the hot path.

**Implementation (`src/core/storage/sqlite-session-store.ts`)**

Inside the existing fact-ingest block in `insertSession`'s txn:

1. `DELETE FROM facts WHERE source_session_id = ?` (existing — wipes prior self-facts on re-ingest).
2. `insertManyInTxn(facts)` (existing — inserts the new fact rows so their ids are visible to subsequent UPDATEs without tripping the FK).
3. **New B.4 loop**: for each new fact, `SELECT id FROM facts WHERE subject=? AND predicate=? AND superseded_by IS NULL AND id != ? ORDER BY created_at DESC LIMIT 1`. If a row returns, `UPDATE facts SET superseded_by = newFactId WHERE id = priorId`.

Ordering is load-bearing — inserts before updates so the FK target exists. The `CASCADE-SET-NULL` on `superseded_by` already handles the inverse case: when we delete this session's prior facts in step 1, any chains that pointed at them get released, letting step 3 re-establish them with the freshly-inserted rows.

**Always-supersede policy**

Even when the new value matches the prior value exactly, the older row gets superseded. Reasoning:
- Provenance changes: new fact = new `source_session_id` = new evidence.
- Audit value: walking the history shows "we've decided Hono 3 times" — informative, not noise.
- Simplicity: no value-equality short-circuit to maintain.

The classifier emits few enough exact duplicates that row growth from this policy is acceptable.

**No public API changes**

`SqliteSessionStore.insertSession` signature unchanged. Callers don't opt in to supersedence; it's a property of the ingest path itself. Tests that skip `factSink` (or skip `factStore` entirely) get the old behavior implicitly because the supersedence loop is gated on `factSink !== null` with `facts.length > 0`.

**Tests (173 pass total, up from 164)**

New file `tests/integration/fact-supersedence.test.ts` — 9 tests covering:
- Cross-session collision: old superseded by new, new is current.
- No collision when subject or predicate differs.
- Always-supersede on identical value (provenance-change semantics).
- Three-deep chain A → B → C: each new ingest supersedes only the immediate chain head; `getHistory` walks correctly newest → oldest.
- Re-ingest of same session: CASCADE-SET-NULL releases the old self-fact, B.4 loop re-establishes the chain with the freshly-inserted row.
- `factSink` omitted: supersedence does not fire (verified the seed fact stays current).
- Multi-fact batch ingest: each new fact supersedes its own `(subject, predicate)` predecessor independently.
- `FactStore.list` default exposes only current; `includeSuperseded: true` returns both.

**Verification**

- `npx vitest run` → 173/173 pass.
- `npx tsc --noEmit` clean.
- Three-deep chain via `getHistory` confirmed agent-visible.

**What's still deferred to Phase C**

- LLM-driven semantic dedup for predicates that fragmented despite the closed vocabulary (`consolidate_facts` operator tool). Ships only if real ingest data shows duplicate clusters.

**Next**

Phase B.5 — `scripts/backfill-facts.ts`. One-shot re-classification of historical sessions to populate facts for the corpus that predates B.2 ingest. Resumable via `--from <session-id>` checkpoint.

## 2026-05-19 — Phase B.3: FactRecallService + MCP recall_facts/get_fact_history

The fact-recall read path goes live. Agents can now ask `recall_facts(subject="mac-pro-llm-host", predicate="endpoint")` and get back a 1-3-item JSON array of concrete facts with provenance, instead of fetching 6KB session digests and re-extracting the value from prose.

**FactRecallService (`src/core/recall-facts/fact-recall-service.ts`)**

- Mirrors `RecallService`'s keyword/semantic/hybrid pattern but works on facts. Filter pipeline: SQL pre-filter (subject, predicate, kind, minConfidence, includeSuperseded) → keyword scoring in memory → optional semantic KNN → optional hybrid merge.
- Keyword scoring weights: `value` × 3, `subject` × 1, `predicate` × 1. Value matters most because subject/predicate are typically already exact-matched at the filter step.
- Default `minConfidence: 0.6` per the plan. Facts in [0.4, 0.6) get written by `extractFacts` but stay out of recall unless explicitly lowered.
- Empty-query structured filter (e.g. `subject=foo` with no `query`) falls back to created-at DESC ordering rather than scoring zero.
- Hybrid weights: 0.6 semantic + 0.4 keyword, matching session recall.
- `LLMUnreachableError` from the embedder gracefully degrades to `modeUnavailable: "ollama_unreachable"` for semantic; keyword and hybrid stay functional.

**FactStore port + adapter extensions**

- New port methods (`src/ports/fact-store.ts`): `listForRecall(filter)` for cheap SQL pre-filter, `semanticSearch(vector, limit)` for sqlite-vec KNN, `getHistory(subject, predicate?)` for supersedence chain inspection. New helper type `FactSemanticNeighbor` and filter shape `FactListFilter`.
- `SqliteFactStore` (`src/core/storage/sqlite-fact-store.ts`) implements all three plus `upsertEmbedding(factId, vector)` for the ingest path. `getHistory` groups by predicate when only subject given; returns one chain per (subject, predicate) ordered newest → oldest by `created_at`.

**Ingest writes fact embeddings (`src/core/storage/sqlite-session-store.ts`)**

- After the session txn commits, the existing post-txn best-effort block now also iterates `factSink.facts` and writes `fact_embeddings` rows via `factStore.upsertEmbedding`. One embedder call per fact. Failures don't roll back the session, and don't abort embedding of subsequent facts.
- Embedding text is `${subject} ${predicate} ${value}` — concise, semantically aligned with how an agent would query.
- Cost: N round-trips per session (typically 2-5). Future optimization could batch via Ollama's batch endpoint; not blocking B.3.

**MCP tools (`src/mcp/server.ts`)**

- `recall_facts` — primary agent surface. Input: `query`, `subject`, `predicate`, `kind`, `mode`, `includeSuperseded`, `minConfidence`, `limit`. Output: `FactRecallResult` JSON.
- `get_fact_history` — supersedence chain inspection. Input: `subject`, optional `predicate`. Output: `{subject, predicate, chains}`.
- Both tools registered only when both `factRecall` and `factStore` are present on `McpDeps` — backwards compatible with the pre-B.3 MCP deps shape.
- Tool descriptions inline the closed predicate vocabulary so agents see the allowed predicate strings.

**Composition (`src/cli/nle.ts`)**

- `buildStack()` now also constructs `FactRecallService`. `nle mcp` subcommand wires `factStore` + `factRecall` into the MCP server. `nle start` reuses the same stack.

**Types (`src/shared/types.ts`)**

- New: `FactMatchField`, `FactRecallQuery`, `FactHit`, `FactRecallResult`, `FactHistoryChain`.

**Tests (164 pass total, up from 139)**

- `tests/unit/core/recall-facts/fact-recall-service.test.ts` — 12 tests. Empty-query behavior, exact subject+predicate, superseded exclusion + opt-in, default minConfidence floor + override, kind filter, limit cap, free-text scoring with `matchedIn`, semantic ranking via fake neighbors, LLM unreachable graceful degrade, hybrid score blending exposes both subscores.
- `tests/integration/sqlite-fact-store.test.ts` — 8 new tests for `listForRecall` (subject+predicate, minConfidence, kind), `getHistory` (per-predicate fan-out, single-chain narrowing, empty), `semanticSearch` (L2 ranking, replace-not-duplicate on upsert).
- `tests/integration/mcp.test.ts` — 4 new tests. `recall_facts` happy path, missing-fact-deps error path, `get_fact_history` chain ordering, `createMcpServer` with fact deps wired.
- `tests/integration/scheduler.test.ts` — 1 new test confirming end-to-end embedding writes (1 session + 2 facts = 3 embedder calls; 2 rows in `fact_embeddings`).

**Verification**

- `npx vitest run` → 164/164 pass.
- `npx tsc --noEmit` clean.
- All filter combinations exercised: exact subject+predicate, subject-only, kind-only, free-text, hybrid, semantic-with-unreachable-LLM.

**Next**

Phase B.4 — deterministic supersedence on `(subject, predicate)` collision inside `insertSession`. Before inserting a new fact, query `findCurrent(subject, predicate)`; if found, mark superseded inline in the same txn. Requires watching predicate normalization in real ingest data — if vocabulary fragments too much, iterate the closed list before cementing supersedence behavior.

## 2026-05-19 — Phase B.2: classifier emits facts, ingest writes them atomically

FactStore now fills up on every new session. End-to-end path live: transcript → classifier (extended prompt) → coercer (normalize + closed vocab) → `extractFacts` → `SqliteSessionStore.insertSession` writes session row + facts in one txn.

**Classifier prompt + coercer (`src/core/classifier/prompt.ts`)**

- Added `facts` to the requested JSON shape. Each fact has `kind` (decision|open|attribute), `subject`, `predicate`, `value`, optional `sourceQuote`.
- Closed predicate vocabulary inlined into the prompt — ~22 entries (framework, endpoint, model, port, host, owner, pricing, deadline, status, stack, runtime, library, version, dependency, schema, integration, deployment, repo, branch, decided-on, assumption, blocker, other). The "other" escape hatch handles cases the vocab doesn't cover; B.4 supersedence cement requires this discipline.
- `coerceClassifyResult` lowercases + trims `subject` and `predicate`, maps off-vocab predicates to "other", drops facts missing any required field, drops invalid kinds, clamps `sourceQuote` to 500 chars.
- `facts` is NOT in `REQUIRED_KEYS` — older classifier outputs without it coerce to `[]` rather than throw. Forward-compat with Phase E parity fixtures.

**Pure extract function (`src/core/facts/extract-facts.ts`)**

- `extractFacts(classifyResult, sessionId, createdAt, opts)` → `Fact[]`. Injects id generator (default `fact_<randomUUID()>`) so tests are deterministic.
- Confidence floor: drops all facts when session confidence < 0.4. Above that, per-fact confidence inherits session confidence (per-fact confidence is a later refinement). The 0.6 query-time floor lives in FactStore.list defaults.

**Atomic ingest (`src/core/storage/sqlite-session-store.ts`, `sqlite-fact-store.ts`)**

- `SqliteFactStore.insertManyInTxn(facts)` — sync method that runs inside an existing transaction (no txn opened). Only safe to call from code that has already begun a txn on the same connection.
- `SqliteSessionStore.insertSession` gained an optional 4th param `factSink: {factStore, facts} | null`. When provided, the existing session txn block deletes prior facts for this `source_session_id` then runs `insertManyInTxn`. One txn, session + facts commit or roll back together.
- Re-ingest semantics: facts are wiped and rewritten on every ingest, mirroring how markers behave. Predictable row counts, no duplicate accumulation across ticks.

**Scheduler (`src/core/scheduler/scheduler.ts`)**

- New optional `factStore` in `SchedulerOptions`. When provided, each tick computes `extractFacts(classification, chunk.id, chunk.startedAt)` and passes `{factStore, facts}` into `insertSession`. When null, sessions ingest as before with no facts.
- CLI composition root (`src/cli/nle.ts`) now passes the FactStore through to the scheduler.

**Tests (139 pass total, up from 120)**

- `tests/unit/core/facts/extract-facts.test.ts` — 6 tests covering empty input, full mapping with deterministic ids, confidence floor (both sides — 0.35 drops, 0.4 keeps), default uuid generator format, no id reuse across facts.
- `tests/unit/core/classifier/prompt.test.ts` — 10 tests covering missing/non-array facts, subject + predicate normalization, off-vocab predicate → "other", missing-required-field drops, invalid kind drops, sourceQuote clamping, sourceQuote blank/non-string omission, prompt contains the closed vocabulary.
- `tests/integration/scheduler.test.ts` — 3 new tests: facts land in DB through the scheduler when FactStore provided, backwards-compat (no facts written when omitted), re-ingest replaces facts (no duplicates).

**Verification**

- `npx vitest run` → 139/139 pass.
- `npx tsc --noEmit` clean.
- Test for atomic semantics covered indirectly via the txn (no separate failure-injection test for B.2 — could add a fake FactStore that throws inside the txn for B.4).

**Next**

Phase B.3 — `FactRecallService` + MCP `recall_facts` + `get_fact_history`. Read path goes live. Reuses `tokenize` and `score-keyword` from the existing recall service. Semantic search wires `fact_embeddings` vec0 table (already created in migration 004).

## 2026-05-19 — FactStore design + Phase B.1 storage substrate

Designed and shipped the storage layer for the second unit of memory: facts. Sessions stay primary; facts are the agent-recall projection — normalized `(subject, predicate, value)` triples derived from session classifier output, supersedence-aware via tombstone pointer. Differentiates from Mem0's fact-soup by keeping sessions as the canonical unit.

**Design plan (docs/plans/factstore-design.md)**

Seven decisions documented with Decision/Why per section:
1. Fact model — 10 fields, no `scope` (subject implies it), no `expiry` (`supersededBy` handles it). `sourceQuote` for provenance.
2. Deterministic-first hybrid supersedence — exact `(subject, predicate)` collision marks the old fact superseded on ingest; LLM-driven semantic dedup deferred to operator-triggered `consolidate_facts` (Phase C).
3. Ingest extends classifier prompt, not a separate extractor — one LLM call per session stays one LLM call.
4. Separate `recall_facts` MCP tool, no unified `kind: session | fact` result type — agent and operator want incompatibly-shaped results.
5. Same SQLite file, separate port + adapter — atomic session+facts transactions; hexagonal discipline preserved.
6. Two MCP tools: `recall_facts`, `get_fact_history`. No `write_fact` (facts are derived, not asserted).
7. One-shot backfill script over existing session bodies via classifier re-run. No lazy-on-read.

Phased rollout B.1 → B.6, plus deferred Phase C.

**Phase B.1 shipped (this commit)**

- `src/shared/types.ts` — added `Fact` interface + `FactKind` union.
- `src/ports/fact-store.ts` — new port. Surface: `insert`, `insertMany`, `getById`, `findCurrent(subject, predicate)`, `list(query)`, `listBySession`, `markSuperseded`. No semantic search yet (B.3).
- `migrations/004_facts.sql` — `facts` table with CHECK constraints on `kind` and `confidence`, partial indexes on `(subject, predicate)` and `subject` filtered to `superseded_by IS NULL` (the hot path), FK to `sessions(id)` with `ON DELETE CASCADE`, plus `fact_embeddings` vec0 table created now to avoid a second migration in B.3.
- `src/core/storage/sqlite-fact-store.ts` — adapter takes an already-opened `Database.Database` handle from `SqliteSessionStore.rawDb()` rather than opening its own connection. One connection, one writer, one transaction across both stores when needed.
- `tests/integration/sqlite-fact-store.test.ts` — 15 tests against real SQLite + real migrations. Round-trip, batch atomicity, supersedence (set/reverse), `findCurrent` filtering, predicate narrowing, `listBySession`, all CHECK + FK constraints exercised.
- `tests/fixtures/facts.ts` — `makeFact()` helper.
- `src/cli/nle.ts` — `buildStack()` now constructs the FactStore. No callers wired yet (B.2 territory).

**Verification**

- `npx vitest run` → 120/120 pass (was 105, added 15 fact tests).
- `npx tsc --noEmit` clean under `strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess`.
- FK constraint test confirmed: facts referencing missing sessions are rejected at insert.
- CHECK constraint tests confirmed: invalid `kind` and `confidence > 1.0` both rejected.

**Next**

Phase B.2 — classifier prompt extension to emit structured `facts[]` alongside existing `decisions[]`/`open[]`/`entities[]`. New pure function `src/core/facts/extract-facts.ts` maps `ClassifyResult.facts` → `Fact[]`. Atomic write into FactStore as part of `SqliteSessionStore.insertSession`. New sessions get facts immediately; old sessions wait for B.5 backfill.


## 2026-05-19 — Post-cutover follow-ups + Phase F /live

Cleared all three open follow-ups from the cutover, then shipped Phase F.

**LaunchAgent for the TS daemon (#120 closes #119)**

- `~/Library/LaunchAgents/io.whtnxt.nle-memory-ts.plist`. Runs `node node_modules/.bin/tsx src/cli/nle.ts start` from the repo dir. `KeepAlive=Crashed` + `SuccessfulExit=false`, `ThrottleInterval=10`. Logs to `~/.nle/logs/ts-daemon-{out,err}.log`.
- Verified: `kill -9` on the daemon process triggered respawn in 2 seconds.
- Used `tsx` instead of compiled `dist/` because path aliases (`@core/@ports/@shared`) require `tsc-alias` rewrite to run from `dist/`. `tsx` handles aliases natively. Add `tsc-alias` later if we want a dist-only deploy path.

**Ollama keepalive (#121)**

- `~/.nle/bin/ollama-keepalive.sh` pings `/api/tags` with a 3 s timeout and runs `open -a Ollama` on failure.
- `~/Library/LaunchAgents/io.whtnxt.ollama-keepalive.plist` fires every 60 s.
- Verified: hard-killed every Ollama.app process; keepalive relaunched the app within 6 s. Notable quirk: Ollama.app rejects `osascript quit` (returns -128) — only `kill -9` actually stops it, which is what today's silent outage looked like.

**GitHub Actions CI (#122 closes #106)**

- `.github/workflows/ci.yml`. `ubuntu-latest`, Node 20, npm cache. Steps: install → typecheck → test (105 tests) → build:server.
- First run on commit `daba989` green: https://github.com/pbmagnet4/nle-memory-ts/actions/runs/26111349080. Better-sqlite3 + sqlite-vec native bindings compile on the runner without extra setup.

**Phase F: /live observability + SPA scaffold (#94)**

The original ask that started this rewrite ships.

- New API endpoints — all read-only, served by the existing Hono app:
  - `GET /api/recall/recent?limit=N` tails the query log JSONL and returns the last N entries (most recent first).
  - `GET /api/live/recent-writes?limit=N` returns recently-written sessions from the store, ordered by `created_at DESC`.
  - `GET /api/live/recent-markers?limit=N` returns recently-extracted markers (decisions + open questions) joined to their parent session.
- Underlying methods on `SqliteSessionStore`: `recentWrites(limit)` and `recentMarkers(limit)`. Direct SQL queries — same pattern as the rest of the store.
- `src/ui/` — Vite + React + TypeScript SPA. Strict TS settings mirror the server (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). React 18 + react-router-dom v6. Vite 5 (pinned to match vitest 2's peer constraint).
- `LivePage` polls all three endpoints every 3 s and renders three columns (Reads, Writes, Decisions) with relative-time labels and source/kind badges. Polling is fault-tolerant — transient endpoint failures don't blank the columns; the next tick retries.
- `StubPage` is shown for the remaining nine pages (pulse, river, thread, search, settings, settings/labels, settings/classifier, settings/data, settings/views). Each route is registered so React Router doesn't 404 — they render a "not yet ported" placeholder pointing at NocoDB #95 for the full SPA port.
- Hono now serves the built SPA: `createApp({ uiDist })` mounts `/ui/*` with static-asset resolution and an `index.html` fallback for client-side routing. Path traversal blocked (`..` and absolute paths refused). `nle start` passes the dist dir when it exists.
- Build: `npm run build` now does `build:server` (tsc) + `build:ui` (vite). UI bundle is ~170 kB JS / ~55 kB gzipped. UI dev server (`npm run ui:dev`) proxies `/api` to localhost:3940 for hot-reload development.

**Decisions**

- React 18 + Vite 5 (not React 19 + Vite 8) — keeps the peer-dependency tree consistent with vitest 2. Upgrade later if we need it; no feature gap today.
- SPA is mounted at `/ui/` (not `/`) so the existing API surface stays at the root and there's no accidental shadowing. React Router uses `basename="/ui"` to match.
- Three columns chosen exactly because that was the original ask (Reads / Writes / Decisions). No "Status" column or "Stats" panel yet — those belong in `pulse` when that page lands.
- Stubs over deleted routes. React Router won't 404 a registered path; navigating to /pulse from the nav doesn't break the SPA, it just shows a placeholder. Less confusing than missing nav items.
- SPA fallback returns `index.html` for any `/ui/*` that isn't a real file. Standard SPA pattern; lets React Router own all client-side routing.
- Static file MIME map is hand-rolled (8 extensions) rather than pulling `mime` as a dependency. Cheap; the only types we serve are HTML/JS/CSS/JSON/PNG/ICO/SVG/MAP.

**State**

- **105/105 tests pass** (12 unit additions, plus 3 new HTTP integration tests for the live endpoints). Typecheck clean on both tsconfigs. CI green on push.
- Live SPA reachable at http://localhost:3940/ui/live with the daemon running. Polled endpoints return real session data from the live store (1,960 sessions, 4,389 entities).
- NocoDB #94 (Phase F /live) ready to close. NocoDB #95 (full SPA port — pulse/river/thread/search/settings) remains backlog at P2.

**Next priorities**

- Watch the live UI under real traffic for a day. Any column rendering nits or polling oddities surface here.
- NocoDB #95 — port the remaining nine pages from the Python Astro UI to React. Each one is a new file in `src/ui/pages/` + a route in `App.tsx` + however many endpoints it needs.
- NocoDB #110 — build codex / gemini / aider TranscriptAdapters when real sample sessions surface (gated on actual runtime usage).

## 2026-05-19 — Phase C.2: embedding port + correctness fixes
## 2026-05-19 — Phase D: Scheduler + ingest pipeline

The TS rewrite now has a running daemon that ingests transcripts end-to-end without the Python daemon's involvement.

**Changes**

- `src/core/scheduler/scan-once.ts`: shared mtime-gated discovery. `scanOnce(adapter, idleMinutes, db, now?)` walks `adapter.discover()`, gates by `now - mtime ≥ idleMinutes*60s`, checks `adapter_state` for known sources, and returns `[{ chunk, supersedes }]` for each idle file with `(no row OR size changed)`. `recordClassified(db, adapterName, sourcePath, sessionId)` upserts the state row. Pulled out of the per-adapter Python implementations because the logic was identical.
- `src/core/storage/sqlite-session-store.ts`: new `insertSession(record, embedder?, supersedes?)`. Atomic txn writes the session row (ON CONFLICT updates in place), deletes + rewrites markers, upserts entities with `candidate`/`candidate` defaults, links via `session_entities`, wires the supersedes edge + flips the prior session's status. Embedding is best-effort outside the txn — embedder failure does not roll the ingest back. Also exposed `rawDb()` for ingest helpers (Scheduler, scanOnce) — bypasses the SessionStore port deliberately, with a doc comment warning recall consumers off it.
- `src/core/scheduler/scheduler.ts`: `ScanScheduler` periodic loop. Each tick walks every registered adapter, scanOnces, classifies each chunk with a wall-clock timeout (default 120 s), drops anything below the 0.3 confidence floor, inserts via `store.insertSession`, then calls `recordClassified` so the next tick is incremental. Classify timeout + classifier errors are contained per-chunk; the tick continues. Returns a `TickReport` (inserted, skippedLowConfidence, classifyFailures, storageFailures, chunksSeen).
- `src/cli/nle.ts`: `nle start` now boots the scheduler alongside the Hono server. `--no-scheduler` to skip; `--interval-min N` to tune (default 30 min). Adapter discovery via `detect()` filters out adapters whose data dir is missing; `NLE_ADAPTERS=claude-code,hermes,pi` forces a specific set. SIGINT/SIGTERM cleanly stop the scheduler and close the DB.
- `tests/integration/scheduler.test.ts`: 6 integration tests against real SQLite + sqlite-vec with stubbed classifier/embedder. Covers end-to-end ingest (row + markers + entity link + embedding + adapter_state), no-op second tick on unchanged files, confidence-floor skip, classifier failure containment, supersedence edge + status flip when a file grows, and re-ingest idempotency.

**Decisions**

- **scanOnce is a free function, not a method on the adapter.** Python bolted it onto each adapter class but the logic never varied. In TS the adapter stays a pure parser conforming to `TranscriptAdapter`; scanOnce is generic over the port. Easier to test, easier to add new adapters (codex/gemini/aider when their data shapes solidify in #110).
- **`rawDb()` exposes the better-sqlite3 handle.** Pragmatic: the ingest helpers need transactions, prepared-statement caching, and JSON-free vec0 inserts that don't fit cleanly through the `SessionStore` port. Kept the recall use case strictly on the port; only Scheduler and ingest paths use rawDb. The doc comment warns off accidental use.
- **Embedding sits outside the ingest transaction.** A slow Ollama would otherwise hold the DB transaction open for tens of seconds. Best-effort write is preferred; the row commits even if the embedder fails. Catches embedder failures silently — `embed-backfill` exists if we need to retry later.
- **Confidence floor 0.3 ported verbatim.** Below that, the chunk is filtered, no row written. Matches Python; revisit if cutover surfaces too many "untitled" sessions.
- **Body cap 200K mirrors Python.** Stops a single 1M-char Hermes session from blowing up `sessions.body`. Recall sees the truncated text; the original file stays on disk for re-ingest.
- **No async worker thread for the tick.** Node's event loop + `await` is enough for filesystem and HTTP-bound work. The Python design used `asyncio.to_thread` to avoid blocking the FastAPI loop; in TS the I/O is naturally async so no thread needed.
- **SIGINT/SIGTERM stops the scheduler before closing the store.** Otherwise a half-applied tick could leave a session row without its adapter_state, double-ingesting on next boot.

**State**

- 102/102 tests pass (96 pre-existing + 6 new scheduler integration). Typecheck clean.
- NocoDB #92 (Phase D) ready to close.
- `nle start` now boots a fully integrated stack: HTTP server (Phase A.3) + MCP-ready (Phase A.4 via `nle mcp`) + ingest scheduler (this). The TS daemon can in principle take over the live capture path from the Python daemon today; cutover (Phase E #93) is the next step.

**Next priorities**

- Phase E cutover decision: when to flip `~/.nle/canonical.sqlite` ownership from Python to TS. Pre-flight: verify a short `nle start --interval-min 5` run against the live dir produces sessions equivalent to what the Python daemon would have inserted. Schema is identical so both can read/write the same SQLite as long as only one is doing writes at a time.
- CI workflow (#106) before declaring cutover-safe.


**Correctness fixes (worth flagging — these were silent bugs)**

While porting `embedding.py` I caught two real defects in the existing TS embedder:

1. **`OllamaClient.embed` ignored its `kind` argument.** nomic-embed-text v1.5 is an asymmetric retrieval model — `search_query: ` for queries and `search_document: ` for stored vectors are part of the training contract, and using the wrong prefix (or none) measurably degrades retrieval. TS was sending raw text. Sessions in `~/.nle/canonical.sqlite` were embedded by Python with the document prefix; TS recall queries were sent raw. Result: semantic recall scores were depressed for every query issued through the TS daemon since Phase A. Fixed: `embed(text, kind)` now applies the correct prefix and truncates to 8 K chars to match Python.
2. **TS embedder did not L2-normalize.** `cosineFromL2()` in `RecallService` assumes unit-length vectors (`cos_sim = 1 - L2²/2`). Live store check via `nle embed-normalize --dry-run`: all 1,960 persisted vectors are already unit-length, so Python was normalizing correctly and the cosine math was right *for stored vectors*. The bug was that any NEW vector produced by TS (currently only used for live recall queries) was non-unit, so query↔document distance comparisons were inconsistent. Fixed: vectors are L2-normalized before return.

The combined effect: TS semantic recall has been working but at degraded quality. Both fixes land here.

**Changes**

- `src/llm/ollama-client.ts`: `embed()` now applies the prefix scheme, truncates at 8 K chars, and L2-normalizes via the new exported `l2Normalize()` helper. The Phase A integration tests still pass because they pre-normalize their fixture vectors.
- `src/core/embedding/embed-backfill.ts`: ports `embed_reembed.py`. `reembedCorpus({dbPath, embedder, statePath?, limit?, bodyChars?, onProgress?})` reads each session (`label + summary + body[:4000]`), re-embeds with the document prefix, and replaces the existing row via DELETE + INSERT (vec0 doesn't support UPDATE on vector columns). Resumable: JSON state file at `$NLE_EMBED_STATE` (default `~/.nle/embed_reembed.state`) records every successful id; interrupting and re-running skips the done set. Saves every 25 rows.
- `src/core/embedding/embed-normalize.ts`: ports `embed_normalize.py`. `normalizeEmbeddings({dbPath, dim?, batchSize?, dryRun?})` walks `session_embeddings`, rewrites only rows whose magnitude deviates from 1.0 by more than 1e-3. Idempotent. Dry-run flag.
- `src/cli/nle.ts`: two new subcommands — `nle embed-backfill [--limit N] [--body-chars 4000] [--state path] [--verbose]` and `nle embed-normalize [--dry-run] [--dim 768] [--batch 100]`.
- `tests/unit/llm/embed.test.ts`: 6 tests covering query/document prefix, 8 K truncation, L2 normalization, and the `l2Normalize` helper edge cases (zero vector preserved, unit-vector output).
- `tests/integration/embed-backfill.test.ts`: 6 tests against real SQLite + sqlite-vec — backfill replaces every embedding and writes state, resumability skips done ids, `--limit` honored, normalize rewrites only the non-unit row, dry-run leaves bytes untouched, normalize is idempotent.

**Decisions**

- `nle embed-normalize --dry-run` against the live store reports `total: 1960, alreadyNormalized: 1960, rewritten: 0` — no migration needed. Useful sanity check before declaring cutover-safe.
- Backfill state is JSON not SQLite. Operational simplicity: `cat ~/.nle/embed_reembed.state` to inspect; `rm` to force a full rebuild.
- `reembedCorpus` opens the DB read-write because vec0 needs DELETE + INSERT; could not use `{readonly: true}`. That's a contrast to the parity CLI which is read-only.
- The 8 K embedding cap is enforced inside `OllamaClient.embed` (not the backfill module) so every embed call goes through the same gate regardless of caller. Backfill's `body_chars` truncation is additive — caps the body slice at 4 K before joining with label + summary, leaving comfortable headroom under 8 K.

**State**

- 96/96 tests pass (12 new: 6 embed unit + 6 backfill integration). Typecheck clean.
- Live store inspection: 1,960 sessions, 1,960 unit-length embeddings, zero zero-vectors. Backfill on the live store would re-embed all 1,960 (~30 min at Ollama Mini speed), which we don't need to run unless we suspect prefix-quality issues with the existing vectors.
- Phase C ingest building blocks are now complete: classifier (DeepSeek default), embedder (Ollama, fixed), backfill + normalize tools. Phase D Scheduler is unblocked.

**Next priorities**

- Phase D Scheduler. Wires adapter.discover → adapter.parseSession → classifier.classify → embedder.embed → SqliteSessionStore ingest. This is where `scan_once` and `record_classified` finally land. Single-process worker thread inside `nle start`.


## 2026-05-19 — Phase C.1b: DeepSeek classifier + default flipped

**Why**

N=10 parity run on Ollama+phi4-mini against canonical.sqlite came back with **0 successes** in the first three sessions: one schema failure (model returned JSON with wrong shape), two 180s timeouts. The Python notes had flagged phi4-mini's quality issues but the live data made it obvious: local 4B models on the Mini aren't viable for the ingest classifier path. Edward asked "cant we just use deepseek v4 flash API" — yes.

Re-ran N=10 on DeepSeek V4 Flash against the same sessions. Results in **51 seconds total**:

```
attempted:           10
succeeded:           9   (1 schema failure on a Hermes session)
schemaFailures:      1
networkFailures:     0
labelExactMatchRate: 33.3%
mean Jaccard ents:   0.681
mean Jaccard decs:   0.667
mean Jaccard open:   0.806
median latency:      ~3.8s/session
```

That's a comfortable go signal. Entity Jaccard 0.68 is what you'd expect from two competent runs over the same transcript (vocabulary variance: "n8n" vs "n8n workflow", etc.). Label exact match at 33% is normal because labels are short and rephrasable; the *information* matches even when the words don't.

**Changes**

- `src/llm/deepseek-client.ts`: `DeepSeekClient` implements `LLMClient`. Hits DeepSeek's OpenAI-compatible `/chat/completions` with `response_format: { type: "json_object" }`, temperature 0.1, max_tokens 1024. Shares the prompt module with `OllamaClient` (single source of truth). `embed()` throws — DeepSeek has no embeddings endpoint; wire OllamaClient for that lane. Uses the same `ClassifierSchemaError` / `LLMUnreachableError` discrimination.
- Wider truncation cap (30K vs 15K) per the Python tests showing DeepSeek V4 Flash reliable to 60K. Stays inside the deterministic zone.
- `src/llm/env-autoload.ts`: ports `classifier.autoload_env`. Reads `~/.nle/.env`, `./.env`, `../.env`, `../../.env` into `process.env` without overriding existing values. Called automatically when the parity CLI or composition root selects DeepSeek.
- `src/cli/classify-parity.ts`: `--provider deepseek|ollama` flag (default flipped to **deepseek**). `buildClient` factory selects implementation. Per-session progress now streams to stderr in real time with `[N/total] elapsed EQ|DIFF|ERR id ent=... dec=... open=...`.
- `src/cli/nle.ts`: composition root now wires a separate `classifier` LLMClient alongside the existing `embedder`. Default classifier is DeepSeek; override with `NLE_CLASSIFIER=ollama` for offline-only. Recall still uses Ollama for embeddings (DeepSeek doesn't expose them).

**Decisions**

- **DeepSeek V4 Flash is the default ingest classifier going forward.** Ollama+phi4-mini remains the offline-fallback option but won't be the production path. Cost note: ~$0.002/session × ~1,200 sessions ≈ $2.50 for a full historical backfill.
- Two LLMClients in the stack: `embedder` (Ollama) and `classifier` (DeepSeek). Recall service only consumes embeddings; the Phase D Scheduler will consume the classifier. Clean split — the port lets us mix providers per use-case without leaking the abstraction.
- Per-session stderr progress is non-negotiable for long-running parity runs. Original C.1 dumped everything at the end which made the CLI look hung. Fixed.
- Did not auto-retry on schema failure (1/10 here). Could add tighter truncation + retry but that's a follow-up if rate climbs above ~15% at N=50. For now, log and skip.

**State**

- 84/84 tests pass (no new tests — DeepSeekClient is exercised by the parity CLI; will add unit tests with injected fetch in C.2 alongside embedding tests).
- NocoDB: #113 (hosted classifier optional) flipped Done — DeepSeek shipped.

**Next priorities**

- Phase C.2: port `embedding.py` + `embed_normalize.py` + `embed_reembed.py`. Backfill path enumerates sessions missing embeddings, batch-embeds via OllamaClient (DeepSeek can't help here), L2-normalizes, inserts into `session_embeddings`. Then we have a fully functional ingest stack ready for Phase D Scheduler.
- Phase D: Scheduler wires adapter `discover` + `parseSession` → `classifier.classify` → `embedder.embed` → `SqliteSessionStore` ingest path. This is where `scan_once` and `record_classified` land.


Entries archived from `CHANGELOG.md` when the rolling cap of 10 is exceeded.

## 2026-05-19 — Phase C.1: classifier port (Ollama) + parity harness

**Changes**

- `src/core/classifier/prompt.ts`: shared prompt module. Exports `CLASSIFIER_SYSTEM_PROMPT` (byte-identical to Python), `truncateTranscript` (first-half + last-half split above 15K chars), `stripJsonFences`, `validateClassifierJson`, `coerceClassifyResult`. Single source of truth so future LLM providers (Anthropic, OpenAI, DeepSeek) reuse the same prompt + validation.
- `src/llm/ollama-client.ts`: real `classify()` replaces the throwing stub. POST to `/api/chat` with `format: "json"`, temperature 0.1, model `phi4-mini:latest` by default. Constructor accepts `fetchImpl` for test injection. New `ClassifierSchemaError` distinguishes "model returned unparseable/wrong-shape JSON" from "Ollama unreachable" — callers decide retry vs inbox routing.
- `src/ports/llm-client.ts`: added `confidence: number` to `ClassifyResult`. Field was present in Python's `ClassificationResult` but missing from the TS port until now.
- `src/cli/classify-parity.ts` + `nle classify-parity` subcommand: reads N sessions read-only from `~/.nle/canonical.sqlite`, runs TS classifier against the body, diffs vs persisted Python output. Reports per-session label exact match + Jaccard similarity on entities/decisions/open sets, plus aggregate means and schema/network failure counts. Output is JSON on stdout (machine-readable) + summary on stderr.
- `tests/unit/llm/ollama-client.test.ts`: 8 unit tests against an injected fake fetch. Covers prompt construction, JSON-mode envelope, fence stripping, missing-keys schema rejection, non-JSON rejection, HTTP error mapping, network error mapping, entity coercion (non-string values → string, whitespace trim, empty drop).

**Decisions**

- Used a `fetchImpl` constructor option for dependency injection. Cleaner than module-level `vi.mock` and lets the same client be instantiated with the real fetch in production. Cost: 1 extra constructor param.
- `classify` throws on schema failure instead of returning null (Python pattern). Reason: TypeScript callers can pattern-match the error type; null returns force null-checks at every call site. Caller in the future ingest pipeline will catch `ClassifierSchemaError` and route to inbox.
- Parity CLI is read-only by construction: `new Database(path, { readonly: true })`. No risk of writing to the live canonical store while running it.
- Jaccard chosen over edit distance for set comparisons. Decisions/open are bag-of-strings; small wording differences shouldn't dominate the metric. Label uses exact lowercase-trim match because labels are short and "the same" is binary.
- Skipped porting `AnthropicClassifier` / `OpenAIClassifier` / `DeepSeekClassifier` for now. The local-live path uses Ollama; hosted providers are backfill-only. Adding them later is a new file each — same prompt module, same `LLMClient` port. Logged as future work in #112.

**State**

- 84/84 tests pass (61 unit + 23 integration). Typecheck clean.
- `nle classify-parity --limit 5 --verbose` ready to run against the live store. Not yet run by Edward — that's the C.1 validation step.
- NocoDB updated: this slice tracked as a new C.1 task.

**Next priorities**

- Edward runs `nle classify-parity --limit 50` against `~/.nle/canonical.sqlite` to verify Jaccard scores. Tolerance band TBD — initial expectation is entity Jaccard ≥ 0.6 mean, decisions ≥ 0.5 mean (decisions are wordier so more variance), label exact match ≥ 30% (small models rephrase frequently).
- C.2: port `embedding.py` + `embed_normalize.py` + `embed_reembed.py`. Real backfill path: enumerate sessions missing embeddings, batch-embed via OllamaClient, L2-normalize, insert into `session_embeddings`.
- C.3 (optional, after Edward's read on C.1 quality): port Anthropic / OpenAI / DeepSeek providers if backfill-via-hosted is still wanted.


## 2026-05-19 — Cutover blockers cleared: idle-status overlay + query log + stats

Addressed the two flagged Phase E cutover blockers before continuing to Phase C.

**Changes**

- `src/core/storage/live-status.ts`: ports `live_session_status` from `dataset.py`. Three-tier overlay from transcript mtime: `< 15 min → active`, `15 min – 24 h → idle`, `≥ 24 h → closed`. Persisted `superseded` always wins; missing file → `closed`. Pure function over the filesystem; `expandHome` mirrors Python's `~/` handling.
- `src/core/storage/sqlite-session-store.ts`: `rowToSession` now applies the overlay on every read. `list()` and `getById()` return live status; persisted values are still preserved on write (only derived `idle` is rejected). Cutover regression closed — UI behavior matches Python daemon for active-but-quiet sessions.
- `src/core/recall/query-log.ts`: ports `log_query` + `stats` from `recall.py`. JSONL append at `$NLE_QUERY_LOG` (default `~/.nle/query_log.jsonl`). Telemetry path is fire-and-forget — never throws. `recallStats(days)` aggregates total / with_results / hit_rate / by_source / top_queries from the rolling window.
- `src/http/app.ts`: `/api/recall` now calls `logQuery` (with `x-recall-source` header passthrough, default `"http"`). `/api/recall/stats` returns real aggregates from the log. `HttpDeps.queryLogPath` lets the CLI / tests override the location.
- `tests/unit/core/storage/live-status.test.ts`: 6 tests covering superseded short-circuit, missing path, missing file, active / idle / closed mtime buckets.
- `tests/integration/http.test.ts`: 1 new test exercising the full write→read loop — two recall calls, the second carrying `x-recall-source: test-source`, then `/api/recall/stats` returns total=2 with correct `by_source` split. Stats-when-absent test still in place.

**Decisions**

- Live-status overlay computed at read time, not stored. Same model as Python — `idle` is derived, never persisted. Means the storage CHECK constraint stays `active | closed | superseded` and the `updateStatus` rejection on `idle` is correct.
- `logQuery` returns `Promise<void>` but the HTTP handler calls it with `void logQuery(...)`. Fire-and-forget — never blocks the response, never raises into the recall path. The test waits 50ms for the appendFile to land before reading; in production this race never matters because the writer outlives the request.
- Spread `...(deps.queryLogPath !== undefined ? [deps.queryLogPath] : [])` to thread the optional override through. Verbose, but `exactOptionalPropertyTypes: true` rejects passing `undefined` as a second-arg-with-default. The alternative — making the parameter `string | undefined` — would have leaked into the `query-log.ts` signature.
- Hit-rate uses 3-decimal rounding to match Python's `round(..., 3)`. Top queries capped at 5 (Python parity).

**State**

- 76/76 tests pass (53 unit + 23 integration). Typecheck clean.
- NocoDB #104 and #105 closed Done as #111. Phase E (#93) is now structurally unblocked; the only remaining work before cutover is Phase C (classifier+embedding) and Phase D (Scheduler).

**Next priorities**

- Phase C: port `classifier.py` + `embedding.py`. Real `OllamaClient.classify` implementation (replaces the throwing stub), embedding generation + L2 normalization, vec0 inserts via `SqliteSessionStore.insertEmbedding`. Parity verification against Python on ~50 real sessions before declaring C done.
- After C: Phase D Scheduler (wires `scan_once` mtime polling + `adapter_state` persistence + `record_classified`).
- CI workflow (#106) lands before Phase C closes.


## 2026-05-19 — Phase B.3 + Phase B close: PiAdapter

**Changes**

- `src/core/adapters/pi.ts`: port of `pi.py`. Handles v3 file shape (5 event types: session, model_change, thinking_level_change, message, custom_message). Only `message` events become turns; `custom_message` (LaPis-style extension hooks) is explicitly excluded. Recursive discover walks `<sessions>/<cwd-slug>/<file>.jsonl`. Aborted-session detection: when all assistant turns carry `stopReason: "error"` and no successful assistant text exists, sets `gitBranch: "aborted"` as a sentinel for the Scheduler/storage layer to decode. `$PI_SESSIONS_PATH` env override honored.
- `tests/fixtures/pi/`: 3 synthetic JSONL fixtures copied from pytest suite.
- `tests/unit/core/adapters/pi.test.ts`: 8 parity tests covering successful session (turns/runtime/id/project_dir), aborted session (still ingests + `aborted` sentinel), custom_message exclusion, recursive discover, zero-byte skip. Mirrors `test_adapter_pi.py` parser slice.

**Phase B scope correction (worth flagging)**

NocoDB task #102 originally listed adapter sequence as claude-code → hermes → pi → **codex/gemini/aider**. The last three were scoped as "ports" but **no Python equivalents exist**. They're a feature gap, not a port gap. Closed #102 (Phase B done at B.3) and opened #110 for the codex/gemini/aider builds as P2 future work, deferred until after cutover. Phase B is complete; Phase C (classifier+embedding) is next.

**State**

- 69/69 tests pass (48 unit + 21 integration). Typecheck clean.
- All three extant Python TranscriptAdapter implementations are now ported with byte-equivalent fixture coverage.

**Next priorities**

- Phase C: port `classifier.py` + `embedding.py` to TS. Implement `OllamaClient.classify` (currently throws) and verify entity assignments + embedding distances diff cleanly against Python output on the same sessions.
- Phase D: Scheduler — wires `scan_once` (mtime-based incremental polling) + `adapter_state` persistence. Pairs the now-pure adapters with storage. This is where `record_classified` lives in the TS design.
- Phase E (cutover) is still gated on #104 (idle-status overlay) and #105 (query log + stats).


## 2026-05-19 — Phase B.2: HermesAdapter

**Changes**

- `src/core/adapters/hermes.ts`: port of `hermes.py`. Handles both file shapes — live `session_<id>.json` (top-level `messages[]`) and `request_dump_<id>_*.json` (messages nested under `request.body.messages[]`). Dedupes by `session_id` in `discover` (session file wins over dump for the same id). Strips system role boilerplate before classification. Tool calls (Hermes-style, at message level) summarized as `[tool_use: name]`; tool_result blocks truncated to 200 chars.
- `tests/fixtures/hermes/`: 6 synthetic fixtures copied verbatim from pytest suite (`session_iso`, `session_unix`, `request_dump`, `paired_session`, `paired_request_dump`, `system_only`).
- `tests/unit/core/adapters/hermes.test.ts`: 6 parity tests covering discover dedup (paired files → 1 path, total 5), parseSession ISO/Unix/dump shapes, system-only returns null, and safeSessionId collision resistance for same-date Hermes ids. Mirrors `test_adapter_hermes.py`.

**Flags logged as NocoDB tasks**

- `#104` — Idle-status overlay deferred. Visible regression at cutover unless ported before Phase E.
- `#105` — Query log + `/api/recall/stats` aggregation deferred. UI agent-recall panel goes empty at cutover unless ported.
- `#106` — No CI yet. Local-only test runs until GitHub Actions added.

**Decisions**

- Adapter does not import or use `paired_request_dump.json` content directly — it's read only to populate the bySid map and discarded during dedup. Mirrors Python behavior exactly.
- Used a small `isRecord()` type guard to narrow `unknown` JSON down through `data.request.body.messages`. `as Record<string, unknown>` casts where I knew the shape from prior `isRecord` check. Verbose, but `exactOptionalPropertyTypes` made the alternatives uglier.
- `system_only` short-circuit lives in the second-pass turn loop, not in `discover`. discover still surfaces the file; `parseSession` returns null. Matches Python: the scheduler decides what to skip, not the discovery layer.

**State**

- 61/61 tests pass (40 unit + 21 integration). Typecheck clean.
- Phase B is 2/6 adapters done. Remaining: pi (next, freshest), codex, gemini, aider.

**Next priorities**

- B.3: PiAdapter. Per task #102 sequencing — pi is freshest (Task 13 changes from 2026-05-18) so verify fixture set against current parser before porting.
- B.4-B.6: codex, gemini, aider as a batch (long tail, fewer files in practice).
- Then C (classifier+embedding), D (Scheduler — wires `scan_once` + `adapter_state`), E (cutover, gated on #104 and #105).


## 2026-05-19 — Phase B.1: TranscriptAdapter port + ClaudeCodeAdapter

**Changes**

- `src/ports/transcript-adapter.ts`: new port. `TranscriptAdapter` declares `name`, `runtimeVersion`, `transcriptKind`, `detect()`, `discover(options?)`, `parseSession(path)`. Returns `SessionChunk` (parsed) or null. Adapters don't touch storage — they convert files on disk into candidate sessions and stop there.
- `src/core/adapters/common.ts`: shared helpers — `safeSessionId` (collision-resistant ID), `normalizeTimestamp` (ISO/epoch-seconds/epoch-millis coercion), `durationMinutes`. Mirrors Python `_common.py`.
- `src/core/adapters/claude-code.ts`: full port of `claude_code.py`. Discovers `~/.claude/projects/<proj>/<uuid>.jsonl` and subagent `<proj>/<uuid>/subagents/<id>.jsonl`. Parses user/assistant turns, strips IDE envelopes + system-reminder + command tags, summarizes tool_use/tool_result blocks, generates provisional label from first real user turn. Subagent sessions get `cc_sub_<agentId>` ids and a `[subagent <slug>]` label prefix. `scan_once` (live incremental capture) deferred to Phase D where it pairs with Scheduler.
- `tests/fixtures/claude_code/`: same 4 synthetic JSONL fixtures the Python pytest uses, copied byte-for-byte (`standard_iso`, `short_session`, `tool_heavy`, `with_subagent`).
- `tests/unit/core/adapters/claude-code.test.ts`: 8 parity tests covering discover (finds all 4 fixtures, since-filter), parseSession (standard ISO timestamps, short-session duration, tool-heavy envelope summarization, subagent non-crash, empty-file null), detect smoke. Mirrors `test_adapter_claude_code.py`.

**Decisions**

- Port omits `scan_once` and `record_classified` from the Python adapter. Those read/write `adapter_state` rows and need a SessionStore plus an mtime check — they belong with the Scheduler (Phase D), not the adapter slice. Cleaner cut here means the adapter is purely "files on disk → SessionChunk." When Phase D lands, the Scheduler owns the state row and calls `discover` + `parseSession` itself.
- Total bytes counter mirrors Python's `len(line.encode('utf-8'))` per-line sum. Subtle nit: Python adds the bytes of the *trimmed* line; TS adds `Buffer.byteLength(line, "utf8") + 1` for the newline. Net byte_range is close but not identical — within ~tens of bytes per file. Acceptable since `byte_range` is informational metadata, not a key. Will revisit if cutover diff highlights it.
- Adapter does not import any storage symbol. Layering rule: `ports/` defines the seam, `core/adapters/` implements it against the filesystem only. Storage doesn't come into the picture until the Scheduler composes them.
- Used `safeSessionId` exactly as Python: 3+ underscore parts → `${prefix}_${first}_${last}`, otherwise `${prefix}_${rawId}` verbatim. Verified against Python `safe_session_id("cc", "<uuid>")` → `cc_<uuid>`.

**State**

- 55/55 tests pass (34 unit + 21 integration). Typecheck clean.
- Five remaining adapters (hermes, pi, codex, gemini, aider) follow the same shape — each is its own B.x slice. Order per task #102: hermes next, then pi (freshest, Task 13 from 2026-05-18), then codex/gemini/aider as a batch.

**Next priorities**

- B.2: port HermesAdapter (`hermes.py` → `src/core/adapters/hermes.ts`) + fixtures + parity tests.
- B.3: port PiAdapter — depends on Task 13 from 2026-05-18 changes; verify fixture set is current.
- B.4-B.6: codex/gemini/aider as a single batch.
- Once all 6 adapters land, Phase B closes. Then C (classifier+embedding pipeline) → D (Scheduler, which finally wires `scan_once`) → E (cutover).

## 2026-05-19 — Phase A.4 + A.5: MCP adapter, CLI, GitHub push

**Changes**

- `src/mcp/server.ts`: `createMcpServer({recall, store})` registering `recall_sessions` and `get_session` tools that bind **directly** to RecallService and SessionStore — no localhost hop. Pure handler functions (`recallSessionsHandler`, `getSessionHandler`) exported separately for transport-free testing. Response truncation at 25k chars preserved from the Python MCP. Tool descriptions updated to reference Claude Code + Hermes + pi.dev session sources.
- `src/llm/ollama-client.ts`: real `LLMClient` implementation. `embed()` hits `POST /api/embeddings` against `$NLE_OLLAMA_URL` (default `http://localhost:11434`), maps network/HTTP failures to `LLMUnreachableError` so recall degrades to keyword cleanly. `classify()` stub throws — that's Phase B work.
- `src/cli/nle.ts`: commander entry point and **the composition root**. Subcommands: `start` (Hono server on `$NLE_PORT`, default 3940), `migrate` (run pending migrations), `recall <query>` (one-shot CLI query for debugging), `mcp` (stdio MCP transport for `~/.mcp.json` wiring). This is the one file in the repo that imports every concrete adapter.
- `tests/integration/mcp.test.ts`: 6 tests exercising the MCP handlers against a real `SqliteSessionStore` — keyword/entity/kind filters, error-shape for missing IDs, server-construction smoke test.
- Added deps: `@modelcontextprotocol/sdk`, `@hono/node-server`, `commander`.

**Decisions**

- MCP handlers live as pure functions (`recallSessionsHandler`, `getSessionHandler`) with the SDK registration as a thin wrapper. Lets tests skip the transport entirely and verify the in-process binding works without spinning up stdio plumbing.
- `migrate` subcommand routes through `SqliteSessionStore` rather than opening a bare `Database` and calling `runMigrations` directly. Reason: migration 003 declares the `vec0` virtual table, which needs sqlite-vec loaded on the connection. The store constructor already loads the extension before running migrations — reusing it avoids duplicating that bootstrap.
- Used `as never` cast at the two `server.registerTool` call sites instead of widening `ToolResult` to carry an `[x: string]: unknown` index signature. The SDK's generic enforces an open shape on responses; carrying that signature through our handler types would pollute the rest of the code with `unknown` indexing. The cast is one line per tool and the runtime shape is verified by tests.
- `OllamaClient` ships `embed` only; `classify` throws "not implemented." Phase A doesn't run ingest — RecallService only ever calls `embed`. Better to fail loudly when a later phase first calls `classify` than to ship a half-working stub.
- Pushed to `pbmagnet4/nle-memory-ts` as **private**. Will flip to public around cutover (Phase E) once the rewrite is the source of truth, not a parallel.

**State**

- 47/47 tests pass (26 unit + 21 integration across storage/HTTP/MCP). Typecheck clean on both tsconfigs.
- CLI smoke-tested: `nle migrate` against a fresh tmp DB applies all 4 migrations; `nle recall "anything"` returns the empty RecallResult shape from an empty store.
- NocoDB tasks #87, #88, #89 ready to mark Done.

**Next priorities**

- Phase B kickoff (NocoDB #90): port the adapter ports — `TranscriptAdapter`, `Scheduler` — and write the `OllamaClient.classify` implementation against a real prompt. Then Phase C (classifier+embedding pipeline) and Phase D (scheduler).
- Real Ollama smoke-test against `~/.nle/canonical.sqlite` (read-only): point `nle recall` at the production DB and verify semantic mode actually returns the same results as the Python daemon for a few golden queries.

## 2026-05-19 — Phase A.3: Hono HTTP adapter

**Changes**

- `src/http/app.ts`: `createApp({recall, store})` factory returning a Hono instance. Routes mirror the Python daemon API surface so existing UI/MCP clients can repoint without contract changes: `GET /api/health`, `GET /api/recall`, `GET /api/recall/stats`, `GET /api/session/:id`.
- `GET /api/recall` validates `kind` (decision/open), `mode` (keyword/semantic/hybrid), `limit` (1..100) and threads the query into `RecallService`. 400 on bad input, 200 with the existing `RecallResult` shape on success — including `modeUnavailable: "ollama_unreachable"` passthrough when semantic fails.
- `GET /api/recall/stats` ships as a stub (`not_implemented: true` + empty aggregates). Real implementation lands in Phase B once the query log is ported.
- `GET /api/session/:id` reads via `SessionStore.getById`, 404s on miss.
- `tests/integration/http.test.ts`: 9 tests exercising every route against a real `SqliteSessionStore` via Hono's `app.request()` (no port binding, no network). Covers happy paths, validation 400s, 404, entity filter passthrough, and semantic ranking through the real vec0 KNN.

**Decisions**

- Stuck with Python parity on the API verb (`GET /api/recall` with query string) instead of POST. Reasoning: zero-friction swap with existing UI clients and the recall-source telemetry header conventions. Earlier A.2 CHANGELOG mention of `POST /api/recall` was speculative — actual implementation is GET.
- HTTP adapter takes `RecallService` and `SessionStore` directly as deps, not a wider "container" object. Keeps the composition root the only place that knows about wiring.
- Skipped building a real `OllamaClient` LLMClient implementation in this slice. The HTTP layer is LLM-agnostic — it asks `RecallService` for a result, and `RecallService` asks whatever `LLMClient` was passed at composition. Real Ollama adapter lands alongside Phase B classifier+embedding work where it's actually exercised.
- Validation done inline with simple checks rather than zod schemas. Three query params, three rules — zod would be more ceremony than value. Will reconsider if route count grows.

**State**

- 41/41 tests pass (26 unit + 6 storage + 9 HTTP). Typecheck clean on src + test configs.
- No HTTP server bound yet — `createApp` is wired but the CLI `start` command hasn't shipped. That's the A.5 milestone.
- NocoDB task #87 ready to mark Done.

**Next priorities**

- `src/mcp/`: MCP adapter binding `recall_sessions` and `get_session` directly to `RecallService` / `SessionStore`. No localhost hop through HTTP. (NocoDB #88)
- `src/cli/nle.ts`: commander entry point with `start` (boot HTTP + MCP), `recall` (one-shot CLI query), `migrate` (run migrations only) subcommands. Composition root lives here. (NocoDB #89)
- `git init` (or push existing local repo) + first GitHub commit. (NocoDB #89)
- Real `OllamaClient` LLMClient (Phase B kickoff): embed + classify hitting `http://localhost:11434`.

## 2026-05-19 — Phase A.2: SqliteSessionStore + migration runner

**Changes**

- `src/core/storage/migrate.ts`: versioned migration runner. Reads `migrations/<NNN>_<name>.sql` files in sorted order, tracks applied versions in `schema_migrations`, wraps each file in a transaction, defensively upserts the version row. Idempotent — re-running on an up-to-date DB is a no-op.
- `src/core/storage/sqlite-session-store.ts`: concrete `SessionStore` port implementation backed by `better-sqlite3` with `sqlite-vec` loaded via `sqliteVec.load(db)` on connect. Implements `list` (with optional filter), `getById`, `semanticSearch` (vec0 KNN: `embedding MATCH ? AND k = ?`), and `updateStatus`. Rejects persisting derived `idle`. Test-only inserts (`insertSessionForTest`, `insertEmbeddingForTest`) seed sessions + entities + markers + 768-dim vec rows.
- `tests/integration/recall-sqlite.test.ts`: 6 integration tests. Spins up a tmp SQLite per case, runs migrations, seeds 3 sessions with unit-normalized embeddings, exercises `RecallService` end-to-end through the real store. Verifies keyword recall, semantic KNN (distance 0 → cosine 1), hybrid blend, entity filter, and migration idempotency on reopen.

**Decisions**

- Idle-status overlay (mtime-derived) deferred. A.2's store returns persisted status verbatim; the `idle` projection belongs in a later read-side layer (likely the dataset builder when Phase B ports the projection logic).
- Embedding I/O uses raw `Float32Array` ↔ Node `Buffer` (zero-copy view via `Buffer.from(ab, offset, length)`). vec0 accepts the buffer directly; no need for sqlite-vec's `serialize` helper.
- Test seed path lives on the store (`insertSessionForTest`) rather than a freestanding fixture builder. Keeps the SQL parity with future ingest writers in one place; will be replaced when the real ingest writer lands in Phase B.
- Migration runner does not load `sqlite-vec` itself — the store loads the extension before calling the runner so migration 003 (`vec0` virtual table) can execute.

**State**

- 32/32 tests pass (26 unit + 6 integration). Typecheck clean on src + test configs.
- `node_modules/sqlite-vec` resolves on macOS Apple Silicon (sqlite-vec 0.1.6, better-sqlite3 11.x).
- NocoDB task #86 ready to mark Done. Next in sequence: #87 (Hono HTTP adapter) → #88 (MCP adapter) → #89 (commander CLI + first GitHub push).

**Next priorities**

- `src/http/`: Hono app exposing `POST /api/recall`, `GET /api/recall/stats`, `GET /api/session/:id`. Composition root wires `SqliteSessionStore` + real `LLMClient` (Ollama HTTP) + Hono routes.
- `src/mcp/`: MCP adapter binding `recall_sessions` and `get_session` directly to `RecallService` / `SessionStore`. No localhost hop through HTTP.
- `src/cli/nle.ts`: commander entry point with `start`, `recall`, `migrate` subcommands.
- `git init` + first commit + push to GitHub.

## 2026-05-19 — Phase A: scaffold + core/recall port

**Changes**

- New repo `/Users/echalupa/Documents/Coding Projects/nle-memory-ts/`, TypeScript rewrite of the Python daemon at `../nle-memory/`.
- Hexagonal architecture established: `src/core/` (pure), `src/ports/` (interface contracts), `src/{http,mcp,ui,cli}/` (outer-ring adapters). Path aliases `@core/*`, `@ports/*`, `@shared/*`.
- Ports defined: `SessionStore` (with `SemanticNeighbor` for pgvector-portable semantic search), `LLMClient` (embed + classify, `LLMUnreachableError`), `StructuredLogger`.
- `core/recall` ported from `recall.py`: `tokenize`, `scoreKeyword` (label×3, decisions/open×2, summary×1), `applyFilter` (entity + decision/open kind), `RecallService` (keyword + semantic + hybrid with 0.4/0.6 blend and per-mode normalization). Identical regex, identical field weights, identical hybrid math.
- Vitest harness with strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Two tsconfigs: `tsconfig.json` for src/build, `tsconfig.test.json` for tests-included typecheck.
- 26 tests passing across 4 files (`tokenize`, `score-keyword`, `filter`, `recall-service`). All run on in-memory fake adapters — no DB, no network.
- Migrations copied from Python repo (`000_initial_schema.sql` + 3 deltas).
- README documents architecture, pgvector swap path, and differentiation from mem0/graphiti.

**Decisions**

- Stick with hexagonal split (`core/` + `ports/` + outer-ring adapters) over Astro/Next monolith. Framework is a detail; core stays pure.
- HTTP server: Hono (lean, no opinion). UI: Vite + React SPA (clean separation from server). CLI: commander.js. Tauri-wrap deferred to v2.
- SessionStatus type aligned with persisted CHECK values (`active | closed | superseded`) plus mtime-derived `idle`. The earlier `aborted` came from a pi-adapter `git_branch` sentinel, not a status value.
- MCP adapter will bind directly to `RecallService`, not loop back through HTTP. One process, no localhost hop.

**State**

- 26/26 unit tests pass. Typecheck clean on both src and test configs.
- Repo not yet `git init`'d. No commits yet.
- `~/.nle/canonical.sqlite` (1,950 sessions / 4,389 entities) still owned by Python daemon. No writes from TS yet.

**Next priorities**

- `core/storage`: SQLite migration runner + `SqliteSessionStore` implementing the `SessionStore` port (with sqlite-vec extension load for `semanticSearch`).
- Integration test seeding a tiny SQLite + verifying `RecallService` end-to-end through the real store.
- `http/` adapter exposing `/api/recall`, `/api/recall/stats`, `/api/session/:id`.
- `mcp/` adapter binding `recall_sessions` and `get_session` MCP tools directly to `RecallService` / `SessionStore`.
- `cli/nle.ts` with `start`, `recall`, `migrate` subcommands.
- `git init` + first commit + push to GitHub.



## 2026-05-19 — Phase E: cutover — Python daemon retired, TS owns :3940

The rewrite is live.

**Cutover steps performed (in this order)**

1. `launchctl bootout gui/$UID/io.whtnxt.nle-daemon` — clean stop, no auto-restart.
2. `nohup npx tsx src/cli/nle.ts start --interval-min 5 > ~/.nle/logs/ts-daemon.log 2>&1 &` from the repo dir.
3. `curl :3940/api/health` → `{"status":"ok"}`. Adapter detection picked up all three (claude-code + hermes + pi).
4. Smoke-tested keyword, semantic, and hybrid recall against the live store (1,960 sessions). All three modes return relevant hits; semantic ranking pulls expected neighbors at score ~0.5.
5. Verified MCP shim at `/Users/echalupa/.local/share/nle-memory/mcp/index.js` works unchanged — `NLE_DAEMON_URL=http://localhost:3940` points at the new server. Existing Claude Code clients picked up the change with zero config edits; `/api/recall/stats` shows `by_source: {http: 12, mcp: 4, cutover-test: 1}` after a few minutes of live traffic.

**Surfaced incident**

Ollama (`/Applications/Ollama.app`) had crashed at some point during today's session. First semantic recall returned `mode_unavailable: ollama_unreachable`. Fixed with `open -a Ollama`. Not a regression caused by cutover — both daemons hit the same Ollama. But worth flagging that Ollama isn't auto-restarted by anything, so when it dies the local-embed lane goes silent until manual relaunch. Logging it as future work to wire an Ollama keepalive (separate ticket).

**Rollback path (documented for future use)**

```bash
# 1. Stop TS daemon
pkill -f "tsx src/cli/nle.ts start"

# 2. Restore Python daemon LaunchAgent
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.whtnxt.nle-daemon.plist
```

`~/.nle/canonical.sqlite` is shared between both daemons (identical schema), so no data migration is needed in either direction. Only one writer at a time is safe — TS's WAL won't fight Python's WAL, but `adapter_state` rows would diverge if both ran concurrently against the same source files.

**State**

- TS daemon running on :3940 via `nohup` (not a LaunchAgent yet — survives terminal close, but **not Mac reboot**). Tracked as P1 follow-up in NocoDB #119.
- Python daemon stopped + LaunchAgent unloaded.
- 102/102 tests still pass.
- NocoDB #93 (Phase E cutover) closed as #118.

**Next priorities**

- **#119 install LaunchAgent for TS daemon** before next reboot. Needs `npm run build` to produce `dist/` and a plist with `KeepAlive` on non-zero exit. Until done, a reboot silently drops ingest until manually restarted.
- **#106 add CI workflow** now that the daemon is live — test drift would silently weaken what's running in production.
- **Phase F /live observability** (#94) — the original ask that started this rewrite. Three-column UI (Reads, Writes, Decisions) backed by the existing query log + the scheduler's tick reports. Now feasible because all three sources are in one process.
- Watch `/api/recall/stats` for a day to confirm no anomalies in the new pipeline.
## 2026-05-20 — Fix: MCP recall calls were invisible to telemetry

The MCP recall handlers (`recall_sessions`, `recall_facts`) called `RecallService` / `FactRecallService` directly and never logged — only the HTTP `/api/recall` path wrote to `query_log.jsonl` / `fact_query_log.jsonl`. Since the in-process MCP cutover, every agent recall via MCP — the real agent-usage path — was unmeasured; the Recall page and any adoption analysis saw only UI/curl/hook traffic.

**Change**
- `recallSessionsHandler` / `recallFactsHandler` now fire-and-forget `logQuery` / `logFactQuery` with `source: "mcp"`, mirroring the HTTP handler.

**Why it matters:** recall-adoption telemetry was structurally blind to the path that counts. Prerequisite for the recall-hook calibration to mean anything.

**State:** v0.3.0. MCP recall is now visible in the telemetry.


## 2026-05-19 — Phase B.3.1: fact recall reachable by agents (HTTP + proxy + telemetry)

Closed the consumption gap. Phases B.1-B.5 built the FactStore and backfilled thousands of facts, but no agent could call `recall_facts` — the deployed MCP server (`~/.local/share/nle-memory/mcp/index.js`) is an HTTP-proxy bundle from the Python era that only knew `recall_sessions` / `get_session`. Every fact written was unreachable.

**Root cause chain (worth recording):**
- The deployed MCP is a thin HTTP proxy (`nle-memory/mcp/src/index.ts`, esbuild bundle) that calls daemon endpoints. The TS rewrite's own in-process `src/mcp/server.ts` exists but isn't what `.mcp.json` points at.
- The daemon (`io.whtnxt.nle-memory-ts` LaunchAgent) runs **compiled `dist/cli/nle.js`**, not tsx source. Earlier daemon restarts this session (vocab fix, disambiguation) silently no-op'd — the daemon kept running stale `dist/`. Live ingest has been on old classifier code; the backfill (run via `npx tsx`) was always current, so the main corpus work was unaffected.

**Fix — three new daemon HTTP endpoints (`src/http/app.ts`):**
- `GET /api/recall/facts` — full FactRecallService surface (query, subject, predicate, kind, mode, includeSuperseded, minConfidence, limit). Logs every call.
- `GET /api/facts/history` — supersedence chain inspection.
- `GET /api/recall/facts/stats` — telemetry readback (hit rate, top subjects/predicates, by source).
- `HttpDeps` gained `factRecall`, `factStore`, `factQueryLogPath`. `nle start` wires them via `buildStack()`.

**Telemetry (`src/core/recall-facts/fact-query-log.ts`):**
- New append-only log at `~/.nle/fact_query_log.jsonl`, mirroring the sessions query-log. Every `/api/recall/facts` call records query + subject + predicate + result count + source. `factRecallStats()` aggregates hit rate and top subjects/predicates over a day window. This is the measurement surface — without it the FactStore was write-only with no read signal.

**MCP proxy (`nle-memory/mcp/src/index.ts`, separate repo):**
- Added `recall_facts` + `get_fact_history` tools that proxy to the new endpoints. Rebuilt the esbuild bundle, redeployed to `~/.local/share/nle-memory/mcp/index.js`.

**Verification:**
- `npm run build:server` → rebuilt `dist/`; daemon restarted; all three endpoints return 200 live.
- `recall_facts(subject=nle-memory-ts, predicate=framework)` → `{value: "Hono"}`.
- `facts/history(element-pb, stack)` → walks the real stack-evolution chain.
- Stats endpoint confirmed the query log records (`total:1, hit_rate:1` after the first test call).
- `npx vitest run` → 241/241 pass (7 new fact-endpoint HTTP tests).

**Reaches agents when:** each Claude Code / Hermes / pi session spawns the MCP server fresh over stdio, so any **new** agent session now sees `recall_facts` + `get_fact_history`. Sessions already running keep the old tool set until they reconnect.

**Follow-up — resolved same session:** the LaunchAgent (`~/Library/LaunchAgents/io.whtnxt.nle-memory-ts.plist`) was switched from `node dist/cli/nle.js` back to `node node_modules/.bin/tsx src/cli/nle.ts`. The daemon now runs TypeScript source directly — code changes take effect on the next restart with no build step, and the stale-`dist/` failure mode cannot recur. Old plist backed up at `.bak-20260519`. Reloaded via `launchctl bootout`/`bootstrap` (kickstart alone doesn't re-read a plist); verified healthy boot + live fact endpoints.

## 2026-05-19 — NLM Phase 1: settings UI for sources + providers

**Why**

Phase 0 shipped the backend registries (sources, providers, live model discovery, webhook ingest) end-to-end but left the UI consuming the old hardcoded `default_models` map. The Classifier page was the only configuration surface, and it couldn't see anything users added via the API. Closing this loop unlocks the daemon for any user who hasn't memorized the SQLite schema.

**Decision: ship Phase 1 incrementally, don't wait for Phase 2 Tauri shell**

Phase 2 (Tauri wrapper + first-run wizard) is purely additive — window chrome plus an empty-state route. The Classifier rewrite has no dependency on it, and leaving the hardcoded `default_models` map live alongside the registry is real drift risk. Closing the Phase 0 ↔ UI loop now beats coupling the rewrite to packaging.

**Changes**

- `src/ui/lib/registries.ts` (new) — shared types mirroring `SourceRow` / `ProviderRow` from the daemon plus `SOURCE_PRESETS` / `PROVIDER_PRESETS` defaults for the wizards and `fetchSources` / `fetchProviders` / `fetchProviderModels` / `testProvider` helpers. Keeps the three settings pages from copy-pasting types.

- `src/ui/pages/settings/Classifier.tsx` (rewrite) — dropped the `default_models` / `env_present` / `available_providers` fields from `ClassifierInfo`. Provider dropdown now lists configured registry rows (by `name` + kind label). Model dropdown populates from `GET /api/providers/:id/models` whenever the selected provider changes. **Save is gated on a successful `POST /api/providers/:id/test` for the current selection** — test result is keyed by `providerId|model` so changing either invalidates the previous pass. Embedder section unchanged.

- `src/ui/pages/settings/Sources.tsx` (new) — table of configured sources with kind, runtime, path, enabled chip; per-row Enable/Disable, Delete, and Regenerate-token actions. "Add source" opens an inline wizard:
  - Kind picker drives a preset (Claude Code / Hermes / pi.dev / Custom JSONL / Webhook); changing kind re-pulls defaults.
  - Filesystem sources show a Path field with a `~/`-relative hint (native directory picker comes in Phase 2 via Tauri).
  - Custom JSONL adds a field-mapping form (idField / textField / startedAtField / endedAtField) over `parseConfig`.
  - Webhook sources hide the path field and surface a one-time token reveal banner on the response, with Copy + "I've stored it" dismiss. The same banner fires from Regenerate-token. After dismiss the token is gone — the daemon stores it hashed.

- `src/ui/pages/settings/Providers.tsx` (new) — table of providers with kind label, base URL, default model, key-status chip, enabled chip, and a per-row test result column (showing OK + model count + latency, or the error string). "Add provider" wizard picks kind, autofills `baseUrl` / `defaultModel` from `PROVIDER_PRESETS`, password-masked API-key field. Two submit modes: "Save & test" runs `/test` immediately after insert (if it fails the row is kept and the user can edit/delete from the list); "Save without testing" is the escape hatch for offline setup.

- `SettingsSubnav.tsx`, `App.tsx`, `Index.tsx` — added `/settings/sources` and `/settings/providers` to nav, router, and overview-card grid.

**Data page — backup, restore, storage stats (Phase 1.5 slice)**

- `src/core/storage/db-restore.ts` (new) — `vacuumSnapshot` (live-safe `VACUUM INTO`, clean defragmented single-file, no WAL sidecars), `validateRestoreCandidate` (integrity check + confirms `sessions`/`schema_migrations` tables), `stageRestore` (validate then park at `<dbPath>.restore-pending`), `applyPendingRestore` (boot-time promotion — archives current DB to `.pre-restore-<ts>`, drops stale WAL/SHM, swaps the pending file in).
- `src/http/app.ts` — three endpoints: `GET /api/data/stats` (DB size incl. WAL/SHM, per-table row counts, schema version + migration list, sessions-by-runtime), `GET /api/data/backup` (streams a snapshot as `nle-memory-backup-YYYY-MM-DD.sqlite`), `POST /api/data/restore` (multipart upload → validate → stage → `{ restartRequired: true }`).
- `src/cli/nle.ts` — `buildStack()` calls `applyPendingRestore` before the store opens. A daemon can't swap a DB file it holds open, so restore lands on next restart.
- `src/ui/pages/settings/Data.tsx` (rewrite) — Storage (path/size/schema), Tables, Sessions-by-runtime, Backup download, Restore upload with confirm dialog + "restart required" banner. Native file input restyled via `::file-selector-button` to match `.btn`.
- Destructive maintenance actions (compact, wipe) deliberately deferred to the first-run-wizard slice so confirmation patterns are designed once.

**Views page — wired up two dead settings**

- Audit found 2 of 3 Views settings were dead UI: `landing` did nothing (root route hardcoded `/live`), `riverDensity` did nothing (zero consumers). Only `threadSort` worked.
- `src/ui/lib/view-settings.ts` (new) — single source of truth for the type/key/default/read/write; Thread.tsx had its own inline copy, now removed.
- `landing` — `App.tsx` root route navigates to the stored preference; added the missing "Thread" option the type already declared.
- `riverDensity` — `River.tsx` applies `river-density-{compact|comfortable|spacious}`, retuning the three CSS custom properties River already drives its layout from.
- `Views.tsx` — "Reset to defaults" button (disabled at defaults) + a "Saved" flash on user changes.

**Live page — trustworthy, interactive feed**

- `src/ui/lib/api.ts` — `usePolledEndpoint` now returns `{ data, error, lastUpdated, loading }` instead of bare data, so the UI can flag staleness instead of silently showing frozen rows.
- `src/ui/pages/Live.tsx` — `ConnectionBar` with a status dot (Live / Connecting… / Reconnecting… when any poll errors or no success in 9s). Writes + Markers rows open the `SessionDrawer` (Reads can't — the recall log carries no session id). `useFreshKeys` flashes newly-arrived rows for 1.2s; first populated render seeds silently. Stable row keys replace array-index keys. First-load shows "loading…" instead of a false "empty". "Decisions" column renamed "Markers" — it always returned both `decision` and `open` kinds.

**Pulse layout**

- `Pulse.tsx` / `styles.css` — switched the grid to explicit `grid-template-areas`: Coherence + Runtimes stacked in column 1, Recent sessions and Stale alerts each spanning both rows in columns 2 and 3.

**State**

- 234/234 tests green (14 new: 8 `db-restore` integration, 6 HTTP data-management)
- `tsc --noEmit` clean
- `vite build`: 246 kB JS / 31 kB CSS
- NocoDB: task 138 closed (recreated as 139 with closing notes per PATCH workaround)
- Housekeeping: deleted the `test-tool/1` webhook verification session left over from Phase 0 Task 5

**Next priorities**

- Phase 2: Tauri 2 wrapper. Bundle the Node daemon as sidecar, host the Vite SPA in a webview, wire the auto-updater to a GitHub releases feed. Adds a native directory picker that the Sources wizard can fall back to.
- First-run wizard. Empty `sources` table → full-screen flow detecting Claude Code / Hermes / pi.dev presets, then Provider step, then done.
- Signed installers (`.dmg`, `.msi`, `.deb`, `.AppImage`) shipped via GitHub Releases on tag push.

## 2026-05-22 — Hook PATH fix (process.execPath)

**Changes**
- `src/cli/nlm.ts`: replaced bare `node` with `process.execPath` in `nlm hook install` — hook now works when VS Code is launched from Dock/Spotlight where nvm is not on PATH
- Rebuilt `dist/cli/nlm.js`; reinstalled hook via `nlm hook uninstall && nlm hook install`

**Decisions**
- `process.execPath` chosen over hardcoded Homebrew path — captures whatever node the user actively runs
- Task #151 filed: warn nvm users to re-run install after node version upgrades

**State**
- Hook confirmed firing post-fix; corpus at 2,180 sessions / 7,855 facts
- Tasks closed: #143 (MCP wired), #149 (no bug). Filed: #150 (default mode → hybrid), #151 (nvm warning)

**Next priorities**
- Task #150: default recall mode to `hybrid` in MCP server and hook
- Task #151: nvm detection + warning in `nlm hook install`
- Monitor hook firing rate over next 48h


## 2026-05-20 — FTS5 lexical recall: keywordSearch replaces the token-overlap scorer

The keyword leg of recall moved from an in-memory token-intersection scorer to a SQLite FTS5 BM25 query behind a new `SessionStore.keywordSearch` port method — symmetric with the existing `semanticSearch` sqlite-vec leg.

**Changes**
- `migrations/008_fts_rebuild.sql` — one-time safety rebuild of the `sessions_fts` index (table + sync triggers already existed in migration 000, just unqueried).
- `SessionStore.keywordSearch(query, limit)` — FTS5 MATCH with BM25 column weights 10/4/1 for label/summary/body; user input tokenized into a quoted OR query so FTS5 metacharacters cannot reach the parser.
- `RecallService` keyword + hybrid legs call `keywordSearch`; `matchedIn` badges computed in core via `match-fields.ts` from the resolved session (keeps decision/open attribution accurate — those live in `markers`, not FTS).
- Byte-parity test suite (pinned to the retired Python scorer) replaced by a tolerant golden-set recall regression test written before the swap and green throughout.
- Deleted `score-keyword.ts`; `tokenize.ts` retained (used by fact recall).

**Decisions**
- Reused `sessions_fts(label, summary, body)` rather than adding `decisions`/`open` FTS columns — decision/open text already lives in `body`. Tradeoff: those lines get `body` weight, not an explicit 2x; BM25 IDF compensates.
- Hybrid 0.6/0.4 split retained — `mergeHybrid` normalizes each leg by its own max, which absorbs the token-count → BM25 scale change.

**State:** v0.3.0. pgvector remains the optional power-tier swap (open task #96), untouched.

## 2026-05-20 — Fix: recall daemon wedge (corpus-load + WAL bloat)

`/api/recall` intermittently wedged for 10-25s, starving the whole HTTP server (a health check measured 8.2s during recall load).

**Root cause** — `RecallService.search()` called `SqliteSessionStore.list()` on every request, which `SELECT`ed the `body` column: 99 MB of session markdown across 2,097 rows, loaded synchronously on the Node event loop (239ms with `body` vs 35ms without). better-sqlite3 is synchronous, so concurrent recalls serialized into multi-second head-of-line blocking. A `sample` confirmed ~50% of a wedge window in one synchronous query, 85% of that reading `body` overflow pages. The recall path never uses `body`.

**Changes**
- `SessionStore.getByIds(ids)` — batched session fetch that omits the `body` column.
- `RecallService.search()` no longer calls `list()`. The FTS5 / sqlite-vec legs already return ranked IDs; recall now resolves only those (~15) sessions via `getByIds` and applies the entity/kind filter post-fetch. Per-query cost is O(hits), not O(corpus).
- `SqliteSessionStore.checkpoint()` + a 5-minute (and boot) `wal_checkpoint(TRUNCATE)` in `nlm start` — the WAL had grown to 38 MB with no checkpoint management and never drained.

**State:** v0.3.0. Recall is O(hits); the WAL stays bounded.



## 2026-05-23 — Recall default flipped to hybrid + daily digest cron + metric design docs

A competitive comparison against rohitg00/agentmemory surfaced that NLM's marketing-worthy differentiation (re-derivation rate, editable timeline) was unmeasured and the agent-facing recall default was producing keyword noise. This session ships the cheapest unblockers and writes design docs for the two metrics that will define NLM's launch.

**Changes**
- `src/mcp/server.ts` — MCP `recall_sessions` / `recall_facts` default mode flipped from `keyword` to `hybrid` (4 fallback sites + 4 doc/schema descriptions). Tool descriptions updated. The Claude Code hook (`src/hook/prompt-recall-hook.ts`) intentionally stays on `keyword` — hybrid's ~5s Ollama embedding round-trip would block every prompt submission, which is a UX regression the existing comment in the hook already warned about.
- `src/core/recall-facts/fact-recall-service.ts` — latent bug fix exposed by the default flip: structured-only fact queries (subject + predicate, no query text) now return the storage-filter rows in both `keyword` AND `hybrid` modes. Previously only `keyword` had this fallback; hybrid silently returned empty for exact lookups.
- `tests/integration/mcp.test.ts` — updated default-mode assertion. All 293 tests green.
- `scripts/nlm-daily-digest.{sh,py}` — new cron-driven script that reads `/api/recall/stats` + recent log, computes real (non-probe) 24h and 7d traffic slices, and posts a plain-text summary to Telegram. Probe patterns explicit in `PROBE_PATTERNS` so the count is honest. Cron installed at `0 7 * * *` (after the existing 6:50am daily-reminders slot).
- `docs/methodology/useful-hit-rate.md` — design doc for the next-turn-citation-match signal that will replace `hit_rate` as the recall-quality KPI. Scoped batch-scan (not real-time hook), works for hook recalls today, MCP recalls pending conversation-id capture.
- `docs/methodology/re-derivation-rate.md` — full design for the strategic NLM metric: detection rule (6 conditions), edge cases, calibration loop, public scorecard format, and explicit explanation of why competitors with destructive lifecycles structurally cannot match it.

**Decisions**
- Hook stays on keyword because the existing comment was right — 5s blocking on prompt submit is unacceptable. Task #152 was filed before this constraint was re-read; the task notes will be updated.
- `useful_hit_rate` deferred from "implement today" to "design today, ship in follow-up." A real implementation requires scanning `~/.claude/projects/*.jsonl` transcripts for next-turn citation matches; that's a 3-4 hour build, not a 30-min one. Shipping the design + the digest cron (with the stub field) today gets the user-visible value live tomorrow morning without locking in an unverified detection algorithm.
- Daily Telegram digest replaces the single June 3 calibration checkpoint Edward had scheduled. From tomorrow morning forward, the question "is NLM being used and is it working" is answered every day by the digest, not waiting on a milestone.
- `re_derivation_rate` is committed as THE strategic metric and the headline scorecard number. Pre-launch marketing readiness (vault `Ventures/nlm-memory/marketing-readiness.md`) blocks on this metric being live with 14+ days of trend data.

**State:** v0.3.0. MCP recall defaults to hybrid. Daily digest cron is live and tested (first auto-fire: tomorrow 7:00am CT). Two new methodology design docs published. Tasks #152, #154 done; #153 design done / implementation deferred; #155 design done / implementation deferred. Remaining open: #153 scanner, #155 detection algorithm + CLI, #156-#160 (hooks, lifecycle, supersedence UI, saved-instances counter, anecdotes).

**Sources:** Whtnxt Agent orchestrator conversation 2026-05-23; tasks #152-#160 in NLM NocoDB base `pqq1fk57lhyx43s`; competitive analysis in `Ventures/nlm-memory/learnings.md`; marketing gate in `Ventures/nlm-memory/marketing-readiness.md`.




## 2026-05-25 — Stop hook (#166): operator-citation signal pipeline

Ships the moat-play piece of the catch-up-vs-moat split: the binary citation signal that becomes the training-data substrate for a future learned reranker. Reuses the SessionEnd + atomic-install pattern from `064a686`.

Stop hook fires on Claude Code's `Stop` event. Reads surfaced IDs from the recall hook memo, scans last assistant turn, POSTs citation events to daemon. Daemon endpoint: `POST /api/recall/cite-event` → `citation-log.jsonl`. Atomic install: smoke-tests all 3 hooks, reverts on failure. 20 new tests (345 total). State: Stop hook live in `~/.claude/settings.json`; daemon restarted healthy on :3940.

## 2026-05-25 — LongMemEval-S baseline (#168): keyword wins, hybrid hurts

First measured baseline on the LongMemEval-S benchmark (500 questions, ~24K haystack sessions, body-only). The numbers rewrite the catch-up narrative. Keyword (FTS5 BM25) R@5 = 96.6% (beats agentmemory's published 95.2%); semantic = 87.2%; hybrid (RRF) = 94.6% — RRF actively degraded quality at k=5. Root cause: 98% of gold sessions exceed the 8000-char embed ceiling, truncating them before vector indexing. Embed-truncation is the smoking gun; prefix asymmetry was ruled out. Ablation at k=20 shows hybrid wins outright. MCP default stays `hybrid`; hook should consider keyword. Fix: raise `MAX_EMBED_CHARS` (#172). Stop hook citation detection confirmed broken in practice (0 citations / 86 fires) — widening filed as #173. Scorer hardened for int answers. 346 tests, build clean.
## 2026-05-25 — Chunk + max-pool semantic index (#175 shipped); LongMemEval-S baseline lifts semantic +2.6, hybrid +1.2

The real fix for the embed-truncation bug that surfaced during the 2026-05-25 baseline (and that the #172 raise-the-ceiling attempt aborted with 54% Ollama 500s). Body is now split into ≤7,500-char chunks with 500-char overlap, each chunk embedded independently, and recall scores sessions by the max cosine across their chunks. Chunk size sits safely below the observed 8K-char Ollama failure cliff for nomic-embed-text.

**Schema (migration 009):**

- `session_embedding_chunks` — vec0 with `chunk_id INTEGER PRIMARY KEY`, `embedding float[768]`, aux columns `+session_id TEXT` and `+chunk_idx INTEGER` (BigInt-bound to satisfy vec0's strict integer typing on aux columns; better-sqlite3 binds JS numbers as FLOAT otherwise).
- `session_chunk_map` — regular table keyed on `chunk_id` with `session_id, chunk_idx`, indexed by `session_id`. Backs `DELETE WHERE session_id = ?` since vec0 has no documented filtering on aux columns.
- `session_embeddings` (single-vector) intentionally left in place. Rollback path: revert recall code, old vectors still live; no forced re-embed at deploy.

**Code:**

- `src/core/embedding/chunk-body.ts` (new) — pure `chunkSessionText({label, summary, body}, opts)`. Header (label + summary) prepended to chunk 0; subsequent chunks are body-only windows with overlap. Exports `MAX_CHUNK_CHARS=7500`, `OVERLAP_CHARS=500`.
- `src/core/storage/sqlite-session-store.ts` — ingest now chunks the full body and embeds each chunk independently; per-chunk failures don't roll the ingest back or abort sibling chunks. `semanticSearch` overfetches `k × CHUNK_OVERFETCH=4` chunks, groups by session_id, keeps min distance per session, returns top-k sessions. Recall service interface unchanged. Helpers `deleteSessionChunks`, `insertChunkEmbedding`, and `insertChunkEmbeddingForTest` added.
- `src/core/embedding/embed-backfill.ts` — rewritten for chunked writes. Each session's chunks are embedded into a temp array before any DB mutation, so a partial run leaves the session id off the done-set and is retried whole on resume. Progress log shows `OK (N chunks)`. `bodyChars` option removed (no longer meaningful); `src/cli/nlm.ts embed-backfill` updated to match.
- `scripts/longmemeval/run-harness.ts` — calls `chunkSessionText` on each haystack body and embeds each chunk via the on-disk cache. Per-chunk failures increment the visibility counter rather than aborting the session.
- `src/http/app.ts` — `DATA_STAT_TABLES` now lists `session_embedding_chunks` instead of `session_embeddings` on the Settings → Data page.

**Tests: 372 pass** (up from 362). +10 unit tests for `chunkSessionText` covering empty input, header-only, single-chunk, overflow with overlap, header budgeting, default constants, invalid opts, whitespace trimming. Existing integration tests adjusted minimally: `tests/integration/scheduler.test.ts` counts `session_chunk_map` rows for the embed-row assertion; `tests/integration/embed-backfill.test.ts` normalizeEmbeddings beforeEach seeds the legacy `session_embeddings` table directly via raw SQL because `insertEmbeddingForTest` now writes to the chunk table.

**LongMemEval-S baseline rerun (n=500, k=5):**

| Mode | Single-vector (8K trunc) | Chunked (max-pool) | Δ |
| --- | --- | --- | --- |
| keyword R@5 | 96.6% | 96.6% | 0 (doesn't embed) |
| semantic R@5 | 87.2% | **89.8%** | **+2.6** |
| hybrid R@5 | 94.6% | **95.8%** | **+1.2** |

Directionally correct, below predicted threshold (had projected semantic >92, hybrid >96). Per question type the picture clarifies why:

| Question type | semantic Δ | Comment |
| --- | --- | --- |
| multi-session | +5.2 (91.0 → 96.2) | biggest lift — long sprawling sessions where truncation hurt most |
| single-session-user | +7.1 (78.6 → 85.7) | second-biggest — truncation killed answer-tail visibility |
| knowledge-update | +3.8 (88.5 → 92.3) | solid |
| temporal-reasoning | 0 (82.0 → 82.0) | unchanged — answer dispersed across many sessions, max-pool doesn't help |
| single-session-assistant | -1.8 (98.2 → 96.4) | small regression |
| single-session-preference | -3.3 (90.0 → 86.7) | regression |

Pattern: chunking strongly helps long-body question types where truncation was the bottleneck, slightly hurts short-body types where the single full-body vector was already sufficient and splitting introduced semantic noise. Net positive on aggregate. Elapsed 91.4 min, cache grew 20,127 → 47,652 (27,525 new chunk embeddings).

**#171 MCP default resolved: keep `hybrid`.** Hybrid now wins or ties 4/6 types and beats keyword on multi-session (98.5 vs 96.2), single-session-assistant (100 vs 100 — tie), single-session-preference (93.3 vs 86.7), knowledge-update (97.4 vs 100 — close, keyword edge). At k=5 aggregate keyword still leads by 0.8 but the prior k=20 ablation (this CHANGELOG below) showed hybrid winning outright at MCP's typical recall width. Hybrid default stays. Hook surface (3 IDs/fire, narrow-k) is a separate question — consider keyword there for top-of-list confidence; defer to real citation data once #173 starts accumulating.

Storage cost: ~2.4× chunks vs sessions on this corpus (47.6K chunks for ~20K sessions in the cache).

**Operational note for production rollout:** deploying this migration creates the chunk table empty. Live ingest writes chunks for new sessions immediately. Historical sessions still have their single-vector rows in `session_embeddings` but the recall path no longer reads them — until backfill runs they're effectively invisible to semantic search. Run `nlm embed-backfill` after deploy to repopulate. Estimate: ~24K sessions × ~3 chunks × ~265ms ≈ ~5 hours warm.

**Next priorities:**
1. **Diagnose the temporal-reasoning flat and the short-session regressions.** Temporal questions span many sessions and max-pool can't help when the answer is dispersed — likely needs cross-session evidence aggregation, not bigger chunks. Short-session regressions suggest chunking with overlap dilutes the unified-body signal; possible fix: skip chunking when body fits in one chunk (header + body ≤ MAX_CHUNK_CHARS — already the early-return path, so something else is in play; worth a focused ablation).
2. **A/B alternate embedding models behind chunking layer** — candidates: embeddinggemma-300m, nomic-embed-text-v2-moe, jina-embeddings-v3. Each runs through the harness in <2 hours with the cache; only ship a swap if the harness shows ≥+3 points on semantic.
3. **Watch Stop hook citation rate** in real sessions. #173 widened detector should now emit on tool_use of NLM MCP calls referencing surfaced IDs. ~/.nlm/citation-log.jsonl is the surface to check after a few real sessions.
4. **Production backfill.** `nlm embed-backfill` against canonical.sqlite (~5 hours warm). Until run, semantic search on historical sessions is blind — only sessions ingested post-deploy have chunks.
5. **Cross-runtime hook adapters** (Hermes/pi/Codex) still the highest-leverage distribution work — agentmemory ships these today and we don't.

## 2026-05-25 — Stop hook citation widening (#173 shipped) + MAX_EMBED_CHARS lift (#172 attempted, reverted)

**#173 — tool_use channel for citation detection (shipped):**

The original Stop hook detector required the model to write a surfaced session ID verbatim in its prose response — models never naturally do that. 86 fires in the prior session produced zero citations. The widened detector now scans `tool_use` blocks in the last assistant turn for NLM MCP tool calls (`mcp__nlm*__get_session`, `recall_sessions`, etc.) whose input JSON contains a surfaced ID. That's the principled "the model dug into the surfaced session" signal.

- `src/core/hook/transcript.ts` — new `readLastAssistantTurn(path)` returns both prose text AND tool_use blocks together. `readLastAssistantText` kept as back-compat shim.
- `src/core/hook/citation-detect.ts` — new `detectCitations({responseText, toolUses, surfacedIds})` returns `{id, kind: 'tool_use' | 'prose'}[]`. tool_use takes precedence when both fire on the same ID (prevents double-counting). `isNlmTool()` accepts any tool name matching `^mcp__[^_]*nlm[^_]*__` so server-name renames stay covered.
- `src/hook/stop-hook.ts` — `runStopHook` returns `citations: CitationEvent[]` instead of `citedIds: string[]`; `postCitation` carries `kind` through. Hook-log entries now include `citationKinds` alongside `citedIds`.
- `src/core/recall/citation-log.ts` — `CitationEntry.kind` optional field. `appendCitation` persists it when provided.
- `src/http/app.ts` — `/api/recall/cite-event` accepts optional `kind` from request body.

Tests: 362 pass (up from 345). +9 unit tests for `detectCitations` (tool_use precedence, non-NLM-tool exclusion, multiple tool calls, recall_sessions-without-id case); +3 integration tests on the Stop hook + transcript reader.

Daemon restarted via `launchctl kickstart`; smoke-tested `POST /api/recall/cite-event` with `kind:"tool_use"` field — payload persists to `~/.nlm/citation-log.jsonl`. Citation accumulation now starts producing real signal on any NLM MCP tool call referencing surfaced IDs.

**#172 — raise MAX_EMBED_CHARS 8K→28K (ATTEMPTED, REVERTED same session):**

The semantic-underperformance diagnosis pointed at the 8000-char ceiling in `OllamaClient.embed` truncating 98% of LongMemEval-S gold sessions. The fix raised `MAX_EMBED_CHARS` 8000→28000 and the production `sqlite-session-store.ts` body cap 4000→24000, matching nomic-embed-text's nominal 8192-token context (~32K chars).

**The harness caught a catastrophic regression:**

| Mode | Baseline (8K) | Attempted (28K) |
| --- | --- | --- |
| keyword R@5 | 96.6% | 96.6% (unchanged, doesn't embed) |
| semantic R@5 | 87.2% | **15.8%** |
| hybrid R@5 | 94.6% | **75.6%** |
| embed_failures | 451 / ~24K (1.9%) | **12,984 / ~24K (54%)** |

Root cause: Ollama's `/api/embeddings` endpoint returns 500 on a majority of inputs near nomic-embed-text's nominal context limit. The model has the context capacity theoretically; the runtime can't reliably feed it. Half the corpus failed to embed → semantic index half-empty → recall collapsed.

**Reverted.** `MAX_EMBED_CHARS` back to 8000, production body cap back to 4000. Restored the v1 embedding cache (`embeddings-v1-8kchar.sqlite` → `embeddings.sqlite`) so no re-embed cycle needed. Embed test updated back to 8000.

**Guardrail validated.** This is exactly why the 2026-05-25 consensus made the LongMemEval harness a hard-deadline prerequisite for further retrieval work. Without it, the 28K lift would have shipped silently — production semantic recall would have dropped to one-fifth its prior value, agent users would notice "memory isn't finding things anymore," and the cause would have been a one-line constant change three weeks back. Instead: 30 minutes of diagnostic, one revert commit, no production impact.

**Real fix queued as #175:** chunk + max-pool. Split body into ≤8K-char chunks (overlap ~500 chars), embed each, store all vectors keyed by `(session_id, chunk_idx)`. Score = max cosine across chunks per session. Expected to lift semantic past 92% and hybrid past 96% on LongMemEval-S. Storage cost ~2-3× embeddings. Worth running through the harness before any further retrieval algorithm work — same guardrail.

**Next priorities (refined):**
1. **#175 chunk + max-pool** — the real semantic-coverage fix.
2. **Watch Stop hook citation rate** over the next few days. Now that the detector emits on tool_use, real signal should accumulate. If the rate stays near zero, the issue is downstream (agents don't dig into surfaced sessions enough — a UX/prompt problem), not the detector.
3. **#171 MCP default decision** still deferred until #175 lands and the keyword-vs-hybrid gap moves.
4. Cross-runtime adapters (Hermes/pi/Codex) remain the highest-leverage distribution work.



## 2026-05-26 — Production backfill + chunk-acceptance fix: MAX_CHUNK_CHARS 7,500 → 5,500; partial-tolerant backfill; full canonical re-embed

The 2026-05-25 chunk+max-pool ship was calibrated against the LongMemEval-S harness corpus (prose-heavy). First production backfill against canonical exposed two compounding bugs that left ~68% of historical sessions with zero semantic-recall coverage. Today's session diagnosed both, shipped the fix, and re-embedded canonical to 100% session coverage.

**The two bugs:**

1. **All-or-nothing per-session backfill.** `src/core/embedding/embed-backfill.ts:141-155` broke on the first chunk's `LLMUnreachableError` and wrote zero chunks for the session. Live ingest already had per-chunk failure tolerance (per the 2026-05-25 entry); the backfill diverged. With ~2% baseline per-chunk failure rate, a 27-chunk session had ~42% chance of zeroing out — and the canonical distribution had many such sessions.

2. **MAX_CHUNK_CHARS=7,500 was calibrated to prose token-density.** The 8K-char Ollama failure cliff observed during #172's revert holds for prose at ~4 chars/token. Production canonical sessions (Claude Code session bodies with tool_use/tool_result JSON, code blocks, dense structured output) tokenize at ~3 chars/token. Diagnosis via Ollama `/api/show`: `nomic-bert.context_length: 2048` is the architectural cap regardless of the Modelfile's `PARAMETER num_ctx 8192`; raising num_ctx in the request to 8192 changed nothing. Bisect on a failing 6,740-char body found max accepted length **6,388 chars** for token-dense content. The 7,500-char ceiling pushed token-dense chunks 25% over context, returning `{"error":"the input length exceeds the context length"}` 500s.

**The fix:**

- `src/core/embedding/chunk-body.ts` — `MAX_CHUNK_CHARS` 7,500 → 5,500 with updated comment citing the bisect data. Leaves ~14% margin below the 6,388-char cliff for the densest content observed.
- `src/core/embedding/embed-backfill.ts` — per-chunk failure tolerance matching live ingest. Each chunk gets one retry on `LLMUnreachableError` with 200ms backoff. A session is "done" if ≥1 chunk landed (partial max-pool coverage beats none). Progress log distinguishes `OK (N chunks)`, `PARTIAL (N/M chunks, K skipped)`, `FAIL (embedder, K/M chunks)`. Bare `catch {}` on db failures replaced with logged error message.
- `src/core/storage/sqlite-session-store.ts` — `CHUNK_OVERFETCH` now env-tunable via `NLM_CHUNK_OVERFETCH` (default 4 unchanged). Lets future per-corpus ablations skip a code change. No-op for the production path until set.

**Falsified hypothesis: overfetch displacement caused the 2026-05-25 short-body regressions** (preference -3.3, assistant -1.8 in the chunk+max-pool baseline). Ran the harness with `NLM_CHUNK_OVERFETCH=1` and got byte-identical semantic R@5 per question type. The harness is deterministic and overfetch width doesn't affect short-body LongMemEval-S because most sessions have ≤1 chunk — max-pool collapses identically. The -3.3 / -1.8 deltas are almost certainly small-n noise (n=30 and n=56 respectively → one question outcome ≈ 3.3 / 1.8 points) compounded by ε-different cache keys from `.trim()` in the chunker vs `.slice(0, 8000)` in the pre-chunk path. Not worth further harness cycles.

**Tests: 16/16 chunker + embed-backfill tests passing after rebuild.** Chunker tests use `MAX_CHUNK_CHARS` symbolically so the constant change required no test edits.

**Production backfill v2 (MAX_CHUNK_CHARS=5,500, partial-tolerant, ~1h31m elapsed):**

| Metric | v1 (7,500, all-or-nothing) | v2 (5,500, partial-tolerant) | Δ |
| --- | --- | --- | --- |
| Sessions with chunks | 2,109 / 2,239 (94.2%) | **2,240 / 2,240 (100.0%)** | +5.8pp |
| Fully OK sessions | 717 (32.0%) | **1,836 (82.0%)** | **+50.0pp** |
| Partial-coverage sessions | 1,392 (62.2%) | 404 (18.0%) | -44.2pp |
| Fully-failed sessions | 130 (5.8%) | **0 (0.0%)** | **-5.8pp** |
| Chunk acceptance on partials | 23.9% | **67.9%** | **+44.0pp** |
| Total chunks landed | 4,672 | 19,335 | +14,663 |

Every long historical session that previously contributed at most 1-2 max-pool vectors now contributes 5-15. Sessions that previously contributed zero now contribute at least some.

**Residual: 404 sessions still partial (~32% chunk loss).** These are content blocks where even 5,500 chars exceeds 2,048 tokens — extreme token density, mostly JSON-heavy or code-heavy chunks. Closing this gap needs either a longer-context embedder (priority #4) or tokenizer-aware chunking; both are larger projects than today's calibration fix.

**Operational state:**

- Daemon restarted to pick up the new chunker (pid 41333, was 45848). Live ingest now writes 5,500-sized chunks consistent with the backfilled corpus.
- `~/.nlm/embed_reembed.state.pre-chunk-bak` preserved as a backup of the May 17 state file (from the legacy single-vector backfill, pre-chunk era).
- Embedding cache untouched (`~/.cache/longmemeval/embeddings.sqlite` 47,652 entries) — the harness can rerun any of the prior baselines without re-embedding.

**Next priorities (refined from the 2026-05-25 handoff):**

1. **Production backfill: done.** Coverage at 100%, no fully-failed sessions, structural per-chunk acceptance rate dramatically lifted.
2. **Short-body regression diagnosis: closed as noise.** No further harness work warranted on this thread.
3. **Temporal-reasoning flat (82.0):** unchanged. Still needs cross-session evidence aggregation OR query-time expansion — measure before building. Worth running consensus on the design.
4. **A/B alternate embedding models** (priority #4) — now better motivated by today's per-chunk acceptance data than by the original +3 harness R@5 target. The 404 still-partial sessions are the target metric: a model with 8,192-token context (e.g. `nomic-embed-text-v2-moe`, `jina-embeddings-v3`) should accept ~100% of chunks at 5,500 chars. Re-embed canonical + rerun harness; ship swap only if harness ≥+3 on semantic AND per-chunk acceptance ≥+25pp on the still-partial-coverage tail.
5. **Stop hook citation rate** — check `~/.nlm/citation-log.jsonl` after a few real sessions.
6. **Cross-runtime hook adapters** (Hermes/pi/Codex) — still the highest-leverage distribution work.

## 2026-05-26 — Temporal-reasoning failure-mode diagnosis (no code); alt-embedding A/B candidate-set reframed (no 768-dim drop-in)

Diagnostic session continuing from the chunk-acceptance fix earlier today. Investigated priorities #1 (alt-embedding A/B) and #2 (temporal-reasoning) from the handoff. Both produced course corrections rather than ships. No code changes; daemon still on pid 41333.

**Priority #1 — alt-embedding candidate set reframed.** The handoff's premise that `nomic-embed-text-v2-moe` is an 8K-context drop-in for v1.5 is incorrect. Verified against `ollama.com/library/nomic-embed-text-v2-moe` directly: it's a **512-token-context** multilingual MoE with Matryoshka flexible-dim output (768→256) — would make the 404-partial-coverage tail dramatically worse, not better. Surveyed available Ollama embedders: the only candidates with verified ≥4K context are `qwen3-embedding:0.6b` (32K, 1024-dim, 639MB), `bge-m3` (8K, 1024-dim), and `snowflake-arctic-embed2` (8K, 1024-dim). All require migration 010 — parallel 1024-dim vec0 chunk table or a model_id-keyed schema — plus recall-path branching. Original "mostly mechanical, no code changes" framing is dead. Edward chose to defer the migration and pivot to priority #2 first. `qwen3-embedding:0.6b` is the new lead candidate when this work resumes.

**Priority #2 — temporal-reasoning failure modes characterized; cross-session-aggregation hypothesis falsified.** Pulled per-question results from `reports/longmemeval/2026-05-26-00-08-46/results.json`. The 82.0 semantic R@5 on temporal-reasoning is not dispersed-evidence; it's RRF underweighting.

Breakdown (n=133): both legs hit 105 (78.9%); sem-only hit 4; **kw-only hit (RRF-recoverable) 21 (15.8%)**; both-miss floor 3. Either-leg ceiling 97.7%; hybrid captures only 91.0% → 9/130 recoverable hits left on the table by the RRF merge. Temporal is the only question type with a meaningful RRF gap (others 0-3); temporal gap is 9.

The 21 kw-only failures split into two modes:

- **Mode A (15/21 ≈ 71%): named entity + temporal frame** — lexical anchor wins; semantic gets distracted by the temporal frame, not by the named entity. Classic RRF symmetric-weighting failure.
- **Mode B (6/21 ≈ 29%): temporal frame only, no named entity** — neither leg has an anchor. Needs temporal grounding in retrieval.

**Next priorities:** Build E′ (conditional asymmetric RRF); Mode B floor fix; alt-embedding A/B deferred; stop hook citation rate; cross-runtime adapters.

Vault: full diagnosis filed at `Ventures/nlm-memory/track-record.md` (2026-05-26 second entry).


## 2026-05-27 — Codex CLI adapter: marketplace plugin + MCP config wiring + interactive-mode hook dispatch

Cross-runtime adapter work, first target landed. NLM is now installable on Codex CLI via `nlm connect codex`, which registers a local plugin marketplace, installs the `nlm-memory` plugin, writes a sentinel-bracketed `[mcp_servers.nlm-memory]` block to `~/.codex/config.toml`, and (optionally with `--with-hooks`) drops a legacy `~/.codex/hooks.json` fallback. Designed to mirror agentmemory's distribution pattern but the integration surface for current Codex (0.134.0) is materially different from both Codex Desktop and the wiki's 2026-05-23 prediction.

**What ships**

- `plugin/.codex-plugin/plugin.json` — Codex plugin manifest declaring `mcpServers: "./.mcp.json"` and `hooks: "./hooks/hooks.json"` pointers
- `plugin/hooks/hooks.json` — `UserPromptSubmit` + `Stop` event registrations, scripts referenced via `${CLAUDE_PLUGIN_ROOT}`
- `plugin/.mcp.json` — MCP server registration (spawns `nlm mcp` over stdio); duplicated by the direct config.toml writer for redundancy
- `plugin/scripts/{prompt-recall-hook,stop-hook}.mjs` — esbuild single-file bundles of the existing TS hook entries, build pinned in `scripts/build-codex-plugin.mjs`
- `.agents/plugins/marketplace.json` — marketplace manifest declaring the plugin and its source path (`./plugin`)
- `src/install/codex.ts` — `connectCodex` / `disconnectCodex` / `writeMcpServerToConfig` / `removeMcpServerFromConfig` / `writeLegacyHooks` / `removeLegacyHooks`. Marketplace + plugin add are delegated to the `codex` binary (it owns trust + snapshot state); MCP config and hooks.json are written directly with sentinel markers so disconnect can strip exact regions without touching user-authored content.
- `src/cli/nlm.ts` — `nlm connect codex` and `nlm disconnect codex` commands. Flags: `--source <owner/repo>` (default `pbmagnet4/nlm-memory-ts`), `--local` shortcut for dev, `--with-hooks` to also write the legacy fallback, `--dry-run`.

**The four wrong-then-right turns worth keeping in memory**

1. *Codex hooks are not Claude-Code-shape settings.json entries.* The 2026-05-23 wiki claim of "identical schema, ~95% script reuse" was wrong on the install mechanism. Codex uses a marketplace + plugin architecture. Hook *contract* (events, stdin payload, stdout convention) is identical to Claude Code; install path is entirely different. Script logic reuses verbatim.
2. *Marketplace requires a `.agents/plugins/marketplace.json` at the repo root.* First connect attempt failed with `marketplace root does not contain a supported manifest` until that file landed. Reverse-engineered from `~/.codex/.tmp/plugins/.agents/plugins/marketplace.json` shipped by `openai-curated`.
3. *The marketplace policy field is enum-constrained.* `authentication: "NONE"` rejected as `unknown variant`; only `"ON_INSTALL"` and `"ON_USE"` accepted. NLM has no auth to do, so `"ON_USE"` was picked as a no-op-on-use default. Marketplace went green after the swap.
4. *`--dangerously-bypass-hook-trust` is misleadingly named.* The flag warns "hooks may run without review for this invocation" but in practice does not bypass trust at all. Hooks dispatched only after persisting trust via an interactive Codex session. Once trust landed in `[hooks.state]`, hooks fired in subsequent `codex exec` (non-interactive) calls too. The bypass flag's real role is unclear.

**Verified end-to-end** (`019e69fa-4ea1-7b10-8c66-70bda64ba086` is the codex session used for final validation)

- ✅ `codex plugin marketplace add ./` (local source) succeeds
- ✅ `codex plugin add nlm-memory@nlm-memory-ts` produces `installed, enabled` in `codex plugin list`
- ✅ Cached plugin at `~/.codex/plugins/cache/nlm-memory-ts/nlm-memory/0.3.0/` contains all expected files including dotfile dirs (`.codex-plugin/`, `.mcp.json`)
- ✅ `[mcp_servers.nlm-memory]` block written to `~/.codex/config.toml` between sentinels; idempotent under repeated connects; cleanly stripped on disconnect
- ✅ `UserPromptSubmit` hook dispatches from plugin path: codex stdout shows `hook: UserPromptSubmit` / `hook: UserPromptSubmit Completed`, hook-log gains an entry with codex session UUID (`019e...`), recall ran, gate evaluated, would-inject populated, shadow mode logged correctly
- ✅ Plugin-only default (`nlm connect codex` without `--with-hooks`) fires UserPromptSubmit exactly once per turn. The earlier double-fire with `--with-hooks` enabled (plugin path + legacy `~/.codex/hooks.json` both fired) is exactly why `--with-hooks` stays opt-in
- ✅ `codex_features list` confirms `hooks: stable, true` (so the runtime supports them) but `plugin_hooks: removed, false` (the older feature flag is dead; current path is the `hooks` engine with plugin-bundled config pointers)

**Not yet verified**

- ⏳ `Stop` hook dispatch — needs a one-time interactive trust approval before it fires (Codex only prompts for trust on hooks that have a chance to run; `codex exec` -p with bypass-trust did not surface a Stop prompt). Will land on Edward's next interactive `codex` turn.
- ⏳ Remote marketplace install (`codex plugin marketplace add pbmagnet4/nlm-memory-ts`). The local install is the harder code path (the marketplace.json had to be authored from scratch); remote install reuses the same files via git fetch. Verifying in this session's tail after the GitHub push.

**Trust mechanics, for the future**

Codex persists hook trust per `(source, event, ...)` tuple under `[hooks.state]` in `config.toml`. Once a user approves a hook the first time, subsequent invocations (including `codex exec`) fire without prompting. The hash is content-addressed — a release that changes a script binary requires re-trust. This means `nlm connect codex` from a fresh install always requires one interactive `codex` turn to bootstrap trust before hooks fire; we cannot do that step on the user's behalf.

**Build pipeline**

`npm run build` now chains `build:server` (tsc) + `build:ui` (vite) + `build:codex-plugin` (esbuild). The codex-plugin build is single-file per entry (no dependency tree shipped), platform=node, format=esm, target=node20. Each .mjs is under 10KB.

**Tests**

414 unit + integration pass unchanged. No new test files added in this commit — the install path is exercised by the verified end-to-end smoke flow (`nlm connect codex --local` → `codex exec` → hook-log delta inspection). Test surface for install/codex.ts and the build script should land in a follow-up.

**Wiki correction owed**

`Whtnxt Agent Vault/Ventures/nlm-memory/learnings.md` line 218 lists Codex CLI as "`~/.codex/` JSON-config hooks (identical schema to Claude Code) … ~95% script reuse from Claude Code". The script reuse claim is correct (the .ts files port verbatim); the install-mechanism claim is wrong (marketplace + plugin, not settings.json). Wiki update is the next priority after this commit lands.

**Next priorities** (revised from the morning's stack)

1. Wiki update correcting the 2026-05-23 cross-runtime hook landscape table and adding a Codex plugin Tool Lesson. ← **Up next.**
2. Stop hook validation on Edward's first interactive codex turn (passive — happens whenever).
3. NousResearch Hermes Agent (#165) — has the cleanest `plugin.yaml` hook surface and was identified in the wiki as the next runtime worth a real adapter. I can validate it end-to-end without a TTY, unlike Codex.
4. Mode B pre-mortem and alt-embedding A/B remain shelved.

## 2026-05-27 — Stop-hook multi-turn citation detection: useful_hit_rate goes from structurally 0% to a real metric

Bug-fix to the Stop hook's citation detector. The previous implementation scanned only the LAST assistant turn of the transcript, but `tool_use` blocks live in earlier turns — the typical pattern is `tool_use → tool_result → prose summary`, and Stop fires after the summary. The detector saw prose, found no tool_use, logged 0 citations. Production evidence: 348 Stop firings with surfaced IDs, **zero** citations recorded, despite 23 real `mcp__nlm-memory__*` tool_uses in the matching transcripts over the last 7 days.

**Diagnosis path.** Cross-referenced `~/.nlm/hook-log.jsonl` (stop entries, all `citedIds:[]`) against `~/.claude/projects/<workspace>/<conv>.jsonl` (real assistant turns). Drilled into `1fc5a8f1-00fa-4ff5-85e7-a239072082b2`: recall hook surfaced `cc_7ff73609-…`, the assistant called `get_session({id:"cc_7ff73609-…"})` in turn N-1, then wrote a prose summary in turn N; the Stop hook scanned only turn N and logged `citedIds:[]`. Confirmed by code path at `transcript.ts:48` — the loop returns on the first assistant line found walking from the end.

**Changes**
- `src/core/hook/transcript.ts` — added `readAllAssistantTurns(transcriptPath): ReadonlyArray<AssistantTurn>` that returns every assistant turn in order. Kept `readLastAssistantTurn` as a thin wrapper (single test caller; back-compat for non-Stop callers).
- `src/core/hook/cite-memo.ts` (new) — per-conversation cited-set memo mirroring `memo.ts`. Same state dir (`~/.nlm/hook-state/`, overridable via `NLM_HOOK_STATE_DIR`), filename suffix `.cited.json` so memo-sweep's existing dir-walk cleans both surfaced and cited memos by mtime. `loadCited` / `recordCited` / `clearCited`.
- `src/hook/stop-hook.ts` — `runStopHook` now reads all assistant turns, unions text + tool_uses across them, runs `detectCitations` over the union, dedupes against `loadCited(conversationId)`, posts the fresh ones, and persists via `recordCited`. The `responsePreview` stays as the LAST turn's prose (that's the text Edward saw when Stop fired). Daemon remains blind-append; dedup is hook-local.
- `src/hook/session-end-hook.ts` — `runSessionEnd` now also calls `clearCited` so both memos are cleaned on session close.
- `scripts/backfill-citations.mjs` (new) — one-shot historical replay. Walks `~/.nlm/hook-log.jsonl` to collect surfaced-ID sets per conversation, finds matching transcripts under `~/.claude/projects/`, runs the same detector, dedupes against existing `~/.nlm/citation-log.jsonl` entries, appends fresh citations with a `backfill:true` marker. Idempotent. Dry-run by default; `--commit` writes.

**Validation**
- Tests: 414 unit + integration tests pass (was 396, +18 new). New cases cover: tool_use detected when it's in an earlier turn and the last turn is prose-only (the real-world pattern); dedup across repeated Stop firings on a growing transcript; local memo update even when `postCitation` fails (no double-count on next fire); 10 `cite-memo` cases (load/record/clear/corrupt-file/non-array/path-safety); 3 `readAllAssistantTurns` cases; 2 new session-end cases.
- Typecheck clean on changes (pre-existing `SessionEnd` error in `hook-claude-settings.test.ts` is unrelated and predates this work).
- Backfill dry-run against the live `~/.nlm/hook-log.jsonl`: 42 conversations had surfaced IDs, 37 had a matching transcript, **4 conversations contain at least one tool_use citation the old detector missed**. Lower than the upper bound suggests by raw tool-use count (23) because many tool_uses were `recall_sessions`/`recall_facts` (no surfaced-ID-in-input — those are pull, not push-follow-up). The 4 captured citations are the ones where the model actually drilled into a surfaced session via `get_session(id=...)`.

**Impact.** `useful_hit_rate` (cited / surfaced) goes from a structural 0% to a real signal. This is the training-data substrate for the future learned reranker (each row in the citation log is a `(query, returned_id, was_cited)` triple once joined against `~/.nlm/query_log.jsonl` by `conversation_id`). The 348 stop firings that previously generated zero training rows would have generated ~10-15 if the detector had been working — small but real, and growing with every conversation going forward.

**Methodology note worth keeping.** The bug was diagnosable in <10 minutes by cross-referencing two existing log streams (hook-log.jsonl × Claude Code transcripts) before touching code. Tomorrow's-self version of this rule: when a telemetry metric reads structurally zero, scan the raw inputs the metric is supposed to consume before assuming the metric is correct. Filing in `Operations/what-works/code-quality.md` candidate set.

**Next priorities (unchanged from earlier today's update):**

1. ~~Stop hook citation rate.~~ Shipped.
2. Pre-mortem Mode B before any code. Ceiling +1.5% hybrid temporal — current recommendation is to shelve unless a separate driver emerges.
3. Cross-runtime hook adapters (Hermes / pi / Codex). Unchanged.
4. Alt-embedding A/B — still deferred.

**Source:** Whtnxt Agent orchestrator session 2026-05-27 (continuation from Build F ship). Diagnosis grounded in `~/.nlm/hook-log.jsonl` (342 stop entries, 0 citations) and `~/.claude/projects/-Users-echalupa-Documents-Coding-Projects-Whtnxt-Agent/*.jsonl` (23 NLM tool_uses across 7 days).

## 2026-05-27 — Build F shipped: force-include keyword rank-1 on temporal+entity shape; hybrid temporal +3.0 / aggregate +0.8 / hybrid beats keyword for the first time

Single session arc, ~6 hours: Build E′ (asymmetric RRF multiplicative boost) shipped → harness-tested → falsified by head-baseline → reverted → diagnosed via per-question `results.json` → Probes 1 & 2 designed and run → Build F (post-merge force-include) shipped → confirmed by clean A/B head-baseline → shipped. Three full harness runs (1 cold ~50 min + 2 hot ~25s) plus two probe scripts. Zero false ships.

**Build E′ (falsified path, recorded for audit trail).** Built `src/core/recall/query-shape.ts` with `detectQueryShape(query)` returning `{hasTemporal, hasNamedEntity}` (temporal regex covers "N days/weeks/months ago", "last <day>", "when did", "before/after I", "yesterday/today/tomorrow"; named-entity accepts ALL-CAPS acronyms and mixed-case tokens, excludes days of week and month names to avoid Mode B false-fires). Modified `mergeHybrid` to accept a `boostKeyword` param and multiply the keyword leg's `1/(RRF_K + rank_kw)` by 1.75 on shape match. Added 27 unit tests for `detectQueryShape`. Harness run `2026-05-26-16-39-52` (n=500, ~48 min, partial cache): hybrid temporal 91.0 → 92.5 / aggregate 95.8 → 96.4. Head-baseline rerun with boost disabled on the same cache (`2026-05-26-16-57-47`, 26.3s): **byte-identical numbers**. The lift was 100% cache enrichment from the 7,500→5,500 chunk-size change populating new embeddings; the boost contributed zero. Post-mortem probe: detector fires on 23/133 temporal queries, but on those 23 the multiplicative boost changed zero top-5 results — the boost magnitude (1.75×) was too small to overcome the "session appears in both lists at lower rank" advantage in RRF. Reverted; recorded in [[track-record]].

**Build F (shipped).** Replaced the failed multiplicative boost with a post-merge **force-include**: when shape is `temporal && namedEntity`, ensure `kwHits[0].session.id` is in the merged top-`limit` set; if not, insert at position `limit - 1`, displacing the lowest-confidence merged hit. Sidesteps RRF arithmetic entirely. ~10 lines in `forceIncludeKeywordTop()` helper at `src/core/recall/recall-service.ts`; detector unchanged from E′.

**Pre-build probes justified the build.** Probe 1 joined each hybrid temporal miss's keyword `returnedIds` against the dataset's `answer_session_ids` to compute keyword's rank for the gold session — on the 7 KW-FOUND misses, 5 had keyword rank=1 and 2 were within rank 5 (force-include trivially recovers all 7 if the detector fires). Probe 2 measured detector fire rate by `question_type`: 17.3% on temporal-reasoning, 0% on the two paraphrase types (single-session-preference, single-session-assistant), 1.4-2.6% on the other non-temporal types — bounded blast radius of ~5 queries across 367 non-temporal questions.

**Clean A/B (same hot cache, identical code except the force-include branch).** Build F (`2026-05-26-22-47-07`, cold rebuild ~85 min) vs head-baseline boost-off (`2026-05-26-22-56-53`, 22.1s on now-hot cache):

| Metric | Off | On | Δ |
|---|---|---|---|
| hybrid aggregate | 96.4 | **97.2** | **+0.8** |
| hybrid temporal | 92.5 | **95.5** | **+3.0** |
| all other types | byte-identical | byte-identical | 0 |
| keyword aggregate | 96.6 | 96.6 | 0 |
| semantic aggregate | 91.6 | 91.6 | 0 |

Zero regression on any question type. Detector unchanged from E′ — the difference is force-include sidestepping the RRF math rather than trying to outmuscle it.

**Hybrid finally beats keyword on aggregate** (97.2 > 96.6) — first time on this benchmark. Resolves the structural tension from 2026-05-25 where keyword led aggregate R@5. The 2026-05-23 MCP default flip to hybrid is now backed by k=5 numbers, not just the k=20 ablation.

**Gate check vs the 2026-05-26 brief:** target was `hybrid temporal R@5 ≥ +4 (target ~95+)`. Landed at +3.0 / 95.5 — one question shy of +4 but inside the 95+ landing target. The miss is "Who did I meet with during the lunch last Tuesday?" — detector skips because day-of-week is excluded from the named-entity set (necessary to avoid Mode B false-fires). Adding day-of-week as NE would catch this one question but cost the Mode B exclusions. Not worth the trade at scale.

**Tests:** 186 unit tests pass (added 27 for `detectQueryShape`); typecheck clean on changes (pre-existing `SessionEnd` error in `hook-claude-settings.test.ts` unrelated). Daemon unchanged (Build F is recall-path code, not ingest/embed).

**Operational gotcha filed.** Mid-session, `~/.cache/longmemeval/{embeddings.sqlite,longmemeval_s_cleaned.json}` vanished between two harness runs — macOS Sonoma+ auto-cleanup of `~/.cache/` during an idle window. Cost ~90 min of cold rebuild + 277 MB redownload. Mitigation: move the cache outside `~/.cache/` via `LONGMEMEVAL_CACHE_DIR=$HOME/.local/share/longmemeval` before the next harness run. Full diagnosis in `Operations/Tool Lessons/longmemeval-harness.md` (vault) — also captures the harness performance envelope and the pre-build probing methodology.

**Methodology lesson worth keeping.** Two-to-five-line probe scripts catch dead hypotheses cheaper than a full harness run. Pattern: (a) probe detector fire rate on the target distribution, (b) probe detector fire rate on the non-target distribution (blast radius), (c) probe the failure mode's mechanism (rank position, candidate-set membership). Run before harness; the result is right whether or not the build ships. Filed in `Ventures/nlm-memory/track-record.md` and `Operations/Tool Lessons/longmemeval-harness.md`. Candidate addition to `Operations/what-works/code-quality.md` if the pattern recurs outside NLM.

**Next priorities (updated):**

1. **Stop hook citation rate.** Now the highest-leverage moat work — hybrid is structurally sound at 97.2 aggregate; further R@5 work hits diminishing returns until a different lever gets pre-mortem'd.
2. **Pre-mortem Mode B before any code.** Only 2 of 10 hybrid temporal misses are both-leg misses. Ceiling on a successful Mode B fix is +2/133 = +1.5% hybrid temporal. Probe: can a query-time date parser actually resolve those 2 questions' answer windows? If under 50%, the build doesn't justify itself.
3. **Cross-runtime hook adapters** (Hermes / pi / Codex). Unchanged from prior handoff.
4. **Alt-embedding A/B** — still deferred. Hybrid 97.2 is a higher floor than the alt-embedding work was originally framed against. Reopen only when migration 010 is justified by a separate driver.

**Source:** Whtnxt Agent orchestrator session 2026-05-26 → 2026-05-27 (continuation); harness reports `reports/longmemeval/2026-05-26-16-39-52/` (E′ on partial cache), `…16-57-47/` (head-baseline boost off, byte-identical to E′), `…22-47-07/` (Build F on cold rebuild), `…22-56-53/` (head-baseline force-include off, same hot cache as 22-47-07). Probe scripts ephemeral at `/tmp/nlm-eprime/`.

_Older entries archived in CHANGELOG-2026.md_



_Older entries archived in CHANGELOG-2026.md_

## 2026-05-29 — v0.5.0: cross-platform parity, security hardening, model picker

**Cross-platform daemon + hooks** — the missing platforms now install cleanly:

- **Windows hook command format.** `buildHookCommand` is platform-aware: emits `set NLM_HOOK_MODE=mode && "exec" "script"` on Windows so cmd.exe parses it correctly; `smokeTestHookCommand` dispatches via `cmd.exe /c` instead of `sh -c`. Adds `cmdQuote()` for cmd.exe double-quote escaping. Pre-fix, hook install would silently roll back on any Windows-native install because the POSIX `sh -c` smoke test failed at `spawnSync`.
- **Linux systemd user unit.** New `~/.config/systemd/user/nlm.service` template — `Type=simple`, `Restart=on-failure`, logs to `~/.nlm/logs/daemon-{out,err}.log`. `nlm install` / `nlm uninstall` / `nlm setup` all branch into systemd on Linux (was hint-only). Detects `XDG_RUNTIME_DIR` + `systemctl --user` presence so headless servers get a `loginctl enable-linger` callout instead of a confusing error.
- Setup wizard now branches on `process.platform` for all three OSes; macOS LaunchAgent flow unchanged.

**Hook mode default flipped: shadow → live.** Shadow remains opt-in via `NLM_HOOK_MODE=shadow` in the command, but the wizard and `nlm hook install` now ship `live` so new users see pointer-block injection on the first prompt. Earlier behavior left the hook silent until the user found the toggle, which fails the recall hook's own value prop. Install message text + descriptions updated.

**Security hardening** — closes three classes of exposure on top of the existing 127.0.0.1 bind:

- **`~/.nlm/` perms backfill.** New `src/install/nlm-dir-perms.ts` recursively chmods dirs → `0o700` and files → `0o600`, idempotent, runs on every `nlm setup`, `nlm install`, and `nlm start`. Covers the upgrade path for installs from before v0.4.2 (when explicit chmod was added only to `writeClassifierConfig`'s output) — existing `~/.nlm/.env` and `canonical.sqlite` would otherwise stay `0o644` forever.
- **Local-only HTTP middleware** on `/api/*`. Threat model: external network blocked by bind, but DNS rebinding, browser drive-by from cross-origin tabs, and port-forwarded clients on other machines remained. New middleware enforces (1) Host header on the allowed loopback list with or without port, (2) Origin header (when present) on the same loopback list, (3) Bearer token (`Authorization: Bearer ${NLM_MCP_TOKEN}`, timing-safe compared) when Origin is absent. `/api/health` bypasses Origin/Bearer for liveness probes but is still Host-checked. Skipped under Vitest via `!!process.env["VITEST"]` so in-process `app.request()` tests still work.
- **Auto-generated `NLM_MCP_TOKEN`.** New `ensureMcpToken()` in `src/install/ollama.ts` generates 32 random bytes (64-char hex, 256-bit entropy) and persists to `~/.nlm/.env` if no token is set. Idempotent — re-reads file before writing to survive parallel setup runs. Called from `runSetup` and `nlm start` so existing installs upgrade without operator action.
- **Hook auth headers.** New `src/hook/hook-auth.ts` exports `hookAuthHeaders()` that attaches Bearer when `NLM_MCP_TOKEN` is set. All three hooks (`prompt-recall-hook`, `session-start-hook`, `stop-hook`) now call `autoloadEnv()` at startup and route their fetch headers through it so they continue to reach `/api/recall` and `/api/recall/cite-event` after the gate goes on.

**Classifier provider + model picker.** Wizard now asks for provider (DeepSeek cloud / Ollama local) and model. DeepSeek path surfaces an explicit privacy callout before the API key prompt. Ollama path queries `localhost:11434/api/tags`, filters out embedding-only models, and shows the rest as a sorted list. Falls back to `phi4-mini:latest` with a warning if Ollama isn't reachable. `writeClassifierConfig` gains a new `({choice, model, apiKey})` overload persisting `NLM_CLASSIFIER`, `NLM_CLASSIFIER_MODEL`, and `DEEPSEEK_API_KEY` in `~/.nlm/.env`.

**Tests:** 601/601 passing.

## 2026-05-30 — v0.5.9: update-check + UI banner so existing users learn about new releases

Today's product-assessment tail: "if someone has an older version of nlm, how will they know when to update?" The honest pre-fix answer was *they don't* — nlm runs locally, the spine ethos says no telemetry, and we had no in-product update notifier. v0.5.9 closes that without breaking the local-first promise.

**The check** lives in `src/core/update-check/check.ts`. One daily unauthenticated `GET https://registry.npmjs.org/nlm-memory/latest`. No callback to a Whtnxt-owned server. No user data transmitted. Same surface `npm install` already touches. Result cached at `~/.nlm/update-check.json` with a 24h TTL — within the window we read from disk, not from npm. Failure modes (offline, registry 5xx, parse error) all collapse to `{disabled: "unknown-error", behind: false}`; the function never throws so a flaky network can't break the daemon. Opt-out: `NLM_DISABLE_UPDATE_CHECK=1`. The semver compare correctly ranks stable releases above prereleases of the same triple (`0.6.0 > 0.6.0-rc.1`) so RC users get told about the stable cut.

**Three surfaces consume it:**

1. **CLI startup banner.** `nlm start` fires the check fire-and-forget after the listen callback. When strictly behind, appends one line to the boot output: `update: 0.5.7 → 0.5.9 available (npm i -g nlm-memory@latest)`. No latency added to the actual startup — the check runs in the background.

2. **HTTP endpoint.** New `GET /api/update-status` returns the structured `{current, latest, behind, checkedAt, disabled?}` payload. Lives behind the same loopback host-header gate as the rest of `/api/*`. Mounted next to `/api/health` since it's the natural twin.

3. **UI banner.** New `src/ui/components/UpdateBanner.tsx` polls the endpoint every 6h (plus once on mount), renders nothing unless `behind: true`. Footer-anchored in `SideNav` so it doesn't compete with primary content. Shows current → latest, the install command in a monospace strip, a Copy button (with `copied ✓` feedback), and a release-notes link to the matching GitHub tag. Collapsed sidenav state degrades to a single pulsing dot with the install command in the title attribute — clicking the dot copies the command. Per-release dismissal cached in localStorage so a user who's deferring an upgrade isn't nagged on every navigation.

**The deliberate non-feature: no one-click auto-install.** The agent design pass weighed it; the right v1 is "show the command, you run it" — exactly what npm-the-CLI does for its own updates. Auto-execution would open real complexity (npm vs pnpm vs volta vs fnm detection, `/usr/local` write permissions on macOS, daemon self-restart, partial-failure recovery) and break the no-shell-execution-from-the-UI surface that's part of what makes the tool trustworthy. Easy upgrade path later: an "Update now" button that opens Terminal.app with the command preloaded, if users actually complain about the copy step.

**Tests.** 13 unit tests in `tests/unit/core/update-check.test.ts` covering: semver compare (newer/equal/older/v-prefix/garbage/prerelease), behind/not-behind/opt-out, cache hit within TTL, cache invalidation past TTL, registry non-OK fallback, fetch-rejection fallback. One HTTP integration test asserting the endpoint shape with opt-out forced on so CI doesn't depend on npm registry reachability. Full suite: 663/663.

**Live smoke** against the real registry: a `currentVersion: "0.5.7"` check returned `{latest: "0.5.8", behind: true}` with a freshly-written cache; the immediately-following `currentVersion: "0.5.8"` call reused the cache (identical `checkedAt`) and correctly reported not behind.

## 2026-06-02 — README credibility-chain pass + dist/ moved to `prepare` build + retroactive PG-adapter plan reconciliation

Critical review of the public README from the perspective of a tech-fluent GitHub browser surfaced six concrete fixes. All shipped in `da36a3e`, pushed.

**README fixes:**
- Test-count drift reconciled. Badge claimed 742, Development section claimed 612, actual `vitest run` count is 726. Both surfaces now agree.
- CI status badge added pointing at `ci.yml` (green on main). The 726-test claim is now backed by a visible verification chain, not an assertion.
- Runtimes badge split. `runtimes-9` replaced with `MCP-9 runtimes` + `hooks-3 runtimes`. The original framing oversold hook coverage that only ships on Claude Code, Hermes Agent, and pi.dev — everything else is MCP-only. Honest framing.
- "Operating system" dropped from the tagline. Opening line now reads `local-first memory layer for AI coding agents`. The README never defined "OS"; tech readers parse undefined jargon as a credibility cost.
- `dist/` removed from git, built via `prepare` lifecycle hook. Now packed to npm via the `files` field and built on git installs automatically. 18,421 deletions. `.gitignore` updated; README Development section rewritten.
- Methodology doc (`docs/methodology-recall-baseline.md`) audited against a 6-item checklist (corpus, query construction, classifier named, retrieval code paths cited, R@k formula, reproducible script). Already credible — no edits needed.

**PG-adapter plan reconciled (`7411fc9`).** Discovered `docs/plans/2026-05-31-pg-adapter.md` untracked in `git status` with 43 unchecked boxes despite all 13 tasks having shipped on May 31 across `f77a8d2` (PgStorage + PgFactStore + PgSessionStore + contract tests) and `ce046f6` (PG-native registries + actions + scheduler + NLM_PG_URL bootstrap). Cross-checked the plan's File Map against `git log --name-only` — every Created/Modified file landed. Bulk-ticked the boxes (`sed -i '' 's/^- \[ \]/- [x]/g'`), stamped a `✅ Resume status — 2026-06-02` block at the top citing both implementation commits, committed as the design record. This is the failure mode `.claude/rules/session-protocols.md` "Mid-execution handoff" was written for — captured to `Ventures/nlm-memory/learnings.md` so the apprentice orchestrator can build a `/session-close` check for it.

**Known asymmetry items not shipped this session** (tracked in `Ventures/nlm-memory/marketing-readiness.md`): no UI screenshot/GIF in the README; 3 stars / 0 forks / 0 issues triggers credibility-asymmetry skepticism; no public CHANGELOG (release-notes sense) for v0.5.20.

## 2026-06-02 — v0.5.21: `nlm upgrade` command + `executeRestartPlan` refactor + hooks doc fix

Closed the UX gap exposed by the v0.5.9 update banner: the banner told users to run `npm i -g nlm-memory@latest && nlm restart` but there was no single command that did both. Added `nlm upgrade` as a first-class CLI subcommand.

**`nlm upgrade`.** Installs the latest npm release (`npm install -g nlm-memory@latest`), busts the update-check cache file (so the banner dismisses immediately), then delegates to the existing restart logic — `launchctl kickstart -k` on macOS with a loaded agent, `systemctl --user restart` on Linux, `pkill + spawn` as fallback, or a clear `unsupported` error. Dev-build detection via `isDevBuild(__filename)` guards against running `npm install -g` from a checkout by mistake: prints a clean warning and exits. Implemented via `subagent-driven-development` against `docs/superpowers/plans/2026-06-02-nlm-upgrade-command.md` (all 5 tasks, 3 commits).

**New helpers module `src/cli/upgrade-helpers.ts`.** `isDevBuild(filename)` and `updateCheckCachePath()` — pure functions, fully unit-tested (4 + 2 tests). Both are used by the upgrade command; `updateCheckCachePath` mirrors the path logic in `src/core/update-check/check.ts` so both sides bust the same file.

**`executeRestartPlan` refactor.** The restart command's `planRestart()` + `switch` dispatch was duplicated into the upgrade command; extracted as `executeRestartPlan(plan, uid)` in `src/cli/restart-helpers.ts`. No behavior change on `nlm restart`; upgrade and restart now share one implementation.

**UI banner.** `UpdateBanner.tsx` `INSTALL_CMD` constant changed from `"npm i -g nlm-memory@latest && nlm restart"` to `"nlm upgrade"` — users see the shorter command that does both steps.

**Hooks doc fix.** `docs/hooks.md` Coverage table was missing the `SessionEnd` hook entirely and the pi.dev row incorrectly described install as `nlm connect pi` only (missing the `pi.on("input", ...)` description). Both corrected.

**Tests.** 4 `isDevBuild` + 2 `updateCheckCachePath` unit tests in `tests/unit/cli/upgrade-helpers.test.ts`. Dev-build warning path smoke-tested manually (`node dist/cli/nlm.js upgrade` from the checkout prints the warning and exits cleanly). Full suite green.

**State.** v0.5.21. The update path is now: see banner → run `nlm upgrade` → done. No multi-command ceremony.

## 2026-06-03 — UI feedback intake: 42 notes → 39 tasks; 13 closed, 2 follow-ups opened

Edward dropped 42 raw UI feedback notes accumulated from using the app. Session organized them into 33 build tasks + 9 terminology/UX decisions, created 39 records in the NLM Tasks NocoDB base (IDs 224-262, breakdown: P0 ×3, P1 ×15, P2 ×15, P3 ×6), resolved the 9 decisions in conversation, and shipped 4 P0/P1 fixes before the session closed.

**`#224` Stale-alerts filter perceived broken — was a UX clarity gap, not a logic bug.** Edward reported clicking High + Recent surfaced Medium alerts. Replicated the `filteredAlerts` `useMemo` filter+sort against live `/api/dataset` (2,051 alerts: 87 high, 1,964 medium); all 6 chip+sort combinations partitioned correctly in Python. The "bug" was that the `.chip.active` CSS was too subtle to read which severity was selected, and no per-chip count meant the user couldn't confirm the filter applied. Fix: counts on chips (`all · 2051`, `high · 87`, `medium · 1964`) + bold/inset-shadow on `.chip.active`. Zero logic change. Captured in `Operations/what-works/code-quality.md` as the "verify before refactoring" debugging discipline.

**`#225` Transparent dropdown background — design-system orphan tokens.** The session-drawer `⋯` menu rendered transparent. Grep showed 14 sites referencing `var(--bg-1)` / `var(--bg-2)` — tokens that don't exist in the design system (which uses `--surface-0/1/2/float`). Undefined CSS vars silently fall back to initial values; no build/lint warning. Fix: added `:root` aliases `--bg-1: var(--surface-float)` and `--bg-2: var(--surface-2)` — one edit resolved all 14 sites (drawer menu, supersede palette, update banner copy button, palette rows, etc). Captured in `Ventures/nlm-memory/learnings.md`.

**`#260` Recall "by source" double-count — not a duplicate.** The "hook" and "session-start-hook" buckets in the Recall page looked like the same source counted twice. Verified by reading `src/hook/recall-over-http.ts` (line 25, `x-recall-source: hook`, fires per UserPromptSubmit, 974 calls/wk) vs `src/hook/session-start-hook.ts` (line 108, `x-recall-source: session-start-hook`, fires once per session start, 89 calls/wk). They are distinct events. Fix: added `SOURCE_LABELS` display map in `Recall.tsx` rendering "Prompt hook (per user prompt)" / "Session start hook" / etc. Raw log keys preserved for backwards compat.

**`#257` Global "Entities" → "Topics" visible-copy rename.** Edward's terminology decision (over "Threads" — would collide with the Thread page — and "Contracts" — implies binding). 8 visible-text sites changed: Pulse KPI + AlertDrawer, Thread page picker copy + count + empty state, Search filter chips + dropdown, SessionDrawer section heading, Settings Index card + Labels page H2 + SettingsSubnav. Internal identifiers (`DatasetEntity`, `entity_colors`, action kinds `label_entity`/`retire_entity`) intentionally unchanged — data-shape, not user-facing. Route `/settings/labels` URL preserved for bookmark compat. Reusable rule captured: visible-copy renames are cheap, identifier renames are expensive — default to renaming labels only.

**`#258` Topic rename — alias-backed overlay, storage canonical untouched.** Inline rename on Settings → Topics rows and the Thread topic header. Writes a `rename_entity` action; overlay reducer keeps last non-reverted target per subject (added `ORDER BY id` to the row scan so last-write-wins is deterministic). `DatasetEntity.display` is a render-only projection; `entity_display: Record<canonical, string>` exposed on the dataset for chip/list lookups. Recall against the prior name still resolves automatically because session.entities continues to carry the original canonical and the recall path only ever sees canonicals — URL filters, action subject_ids, and `?entity=` round-trips all stay on canonical. Rendered display across Thread header + picker, Search topic chips, Pulse Recent sessions + stale-alert chips + AlertDrawer, Settings/Labels rows. Out of scope (deliberate): topic merging, free-text recall aliasing, multi-hop rename chains.

**`#226` Stale alerts add Low tier.** Banding became 31–45 low, 46–60 medium, >60 high (high boundary preserved). Sort: severity rank then age desc. UI: low chip + count, `.chip-inline.severity-low` neutral tint.

**`#227` Pulse as default landing.** `readViewSettings().landing` default → `pulse`. Existing users keep their saved choice; new installs land on Pulse.

**`#228` Live row hover correlation.** Hovering a marker tags any write with the same `sessionId` with `is-related` (accent-glow + accent left border) and vice versa. Reads can't correlate today — `RecentRead` carries no session id; follow-up opened as `#263` for backend addition.

**`#229` Decision + Open Question row actions.** Decisions get stable hash IDs via new `decisionId()` helper (parallel to `openQuestionId()`). Two new overlay action kinds — `dismiss_decision`, `revise_decision`. Open Question row picks up Resolve as a peer to the existing → decision promote. Row gesture replaced with a single MarkerActionMenu dropdown ("actions" → instant or editor) after Edward called out three peer chips reading as confusing. Timestamps moved left as muted metadata. Per-row inline edit triggers from the dropdown.

**`#235 + #236` Pulse card hover scoping.** Coherence and Runtimes are read-only — outline-lift removed. Recent Sessions rows now use surface-2 + accent label hover, matching Stale alerts.

**`#237` Live + global layout viewport lock.** Root cause: `.page-shell { min-height: 100vh }` doesn't bound height, so internal `overflow-y: auto` containers in Live/Pulse/Search/Thread/Settings never engaged. Fix: shell becomes `height: 100vh; overflow: hidden`; `min-height: 0` on `.page-main`; `min-height: 0; overflow-y: auto` on `.page-pad`. Live gets 20px bottom padding + `overflow-x: hidden` + `overflow-wrap: anywhere` on rows to handle long unbroken strings.

**Live polish (Reads + Writes).** Recall logging extended with `x-recall-runtime` header end-to-end (hook scripts → `/api/recall` → query_log.jsonl → `/api/recall/recent` → UI). Reads tag prefers runtime when present; falls back to source for legacy entries. `recentWrites()` (both SQLite + PG) now joins `session_entities` and surfaces top 2 + overflow count as topic chips on each write row.

**Recent Sessions card.** Trailing entity list dropped (label conveys context); per-card timeframe label ("last 24h", "last 3d") added in the card head, computed from the oldest displayed session. `relativeAge()` "today" → "0d" for format uniformity.

**`#259` Topic Coherence resolution actions.** Card renamed Coherence → Topic Coherence; bucket label Healthy → Active. New `set_coherence` overlay action; `coherenceOverrides: Map<canonical, "active"|"sparse"|"stale">`; `DatasetEntity.coherence` (effective) + `coherence_computed` (natural) exposed. Bars become clickable buttons → opens `CoherenceDrawer` listing the bucket's topics. Per-row Active/Sparse/Stale chips POST `set_coherence`; revert chip when override diverges from computed. Merge picker deferred as `#264`.

**CoherenceDrawer regression + recovery.** Five iterative polish commits trying to scale width and page-size to viewport landed at "atrocious" (Edward). Reverted via `git revert`, dispatched UI/UX Designer for a written spec (`Vault/Ventures/nlm-memory/brand/coherence-drawer-spec-2026-06-03.md`). Spec named the three regressions (dynamic inline-width fighting CSS rule, `drawer-body-stretch` without ceiling, viewport-derived page size). Rebuild per spec: `.coherence-drawer { width: min(480px, 100vw) }`; plain `drawer-body`; static page size 10; data-bucket-tinted active chips; `aria-busy` busy row; `.drawer-hint` muted paragraph. Lesson: UI feedback that uses scale/depth/proportion vocabulary is a design question — route to UI/UX Designer for a spec before the next implementation commit. Captured in `Operations/what-works/agent-routing.md`.

**Follow-ups opened.** `#263` Live: correlate Reads to writes/markers by session id (backend, deferred). `#264` Topic Coherence drawer: add Merge picker for Sparse topics (needs typeahead + merge_entity overlay).

**State.** 13 tickets closed (#224, #225, #226, #227, #228, #229, #235, #236, #237, #257, #258, #259, #260). 12 commits shipped to main. Type-check + 415 unit tests + fresh `npm run build` all green. Daemon kicked via launchctl after each backend change. NLM Tasks base now at ~30 open items.

## 2026-06-05 — Design system standardization pass: 6 canonical components + cross-cutting standards + Pulse closure

Multi-day arc culminating today. Shipped a coherent component library and a written design system covering every interactive surface on the app. Started from drift findings ("Topic Coherence and Runtimes panels render different UIs and treat row highlighting differently"); ended with a 10-section `src/ui/components/README.md` as the design-system source of truth and ~12 standards locked in code.

**Canonical components added** (`src/ui/components/`):
- `Drawer` — right-anchored slide-in; backdrop/Escape/focus management built in (`blockEsc` prop for nested modals). Refactored AlertDrawer, CoherenceDrawer, RuntimeDrawer (new this session), and River CellPicker to use it. SessionDrawer remains exempt and documented.
- `Pagination` — single source for per-page select + range + nav chips; rendered as Drawer `footer` slot (sticky outside body).
- `FilterGroup` / `FilterChip` — replaces severity/sort/bucket chip duplication across AlertDrawer + CoherenceDrawer.
- `Toast` — imperative `toast.success/error/info` API + `ToastHost` mounted at App root; ARIA differentiated by kind (alert for errors, status for success/info); auto-dismiss 4s/8s.
- `Tooltip` — pure-CSS hover/focus-within reveal; `max-width: 240px` for wrapping; `placement="top|bottom"`.
- `ConfirmDialog` — `confirmAction({ title, message, kind })` returns `Promise<boolean>`; replaced all 4 native `confirm()` and 1 `alert()` callsite.

**Helpers added** (`src/ui/lib/`):
- `rowProps(onActivate)` — collapses `role="button" tabIndex={0} onClick onKeyDown(Enter|Space)` boilerplate across 6 row callsites.
- `fmt` — canonical formatters: `count`, `plural`, `percent`, `shortDate`, `daysBetween`; re-exports `relativeAge`.
- `toast` + `confirm` modules — module-level pub/sub for imperative APIs; no provider needed.

**Standards locked in code:**
- Row state machine: hover (`:hover` → surface step-up + label accent tint) → focus (`:focus-visible` → 1px accent outline) → selected (`is-selected` → 2px accent left-border) → busy (`aria-busy="true"`) → disabled (`is-disabled` or `[disabled]`). All canonical CSS lives in one block; naming normalized (`is-active`/`.selected` → `is-selected`).
- Hover surface rule: hover always one step up from parent surface. Fixed `.session-row.clickable:hover` (was invisible inside drawers) + `.data-table tr:hover td`.
- Z-index scale: 12-token semantic scale (`--z-base` through `--z-toast`) with 10-unit gaps; refactored 13 raw `z-index` callsites; killed `199/200` fragile pair (now `50/60` for drawer backdrop/drawer).
- Transition tokens: `--ease-fast` / `--ease` / `--ease-slow`; refactored 5 raw timings.
- Button taxonomy: documented `.btn`, `.btn-primary`, `.btn-accent`, `.btn-danger`, `.btn.small`. Added missing `.btn.small` CSS (silent no-op in 6 callsites). Relocated orphan `.btn-danger:hover` from form-row block.
- Form input states: hover, focus-visible (accent outline), disabled (opacity 0.5), invalid (`aria-invalid="true"` → danger border).
- `.form-error` canonical class + `.form-row.between` / `.form-row.tight` modifiers (killed 5 inline `justifyContent`/`gap` style overrides).
- Empty states: consolidated `.alert-row-empty` + `.recall-bars-empty` into canonical `.empty-row` (16px 14px, matches row chrome).
- Icons: documented inline-SVG convention (24×24 viewBox, currentColor, stroke 1.75, no fills, no emoji); Tabler style.
- Status indicators: three families documented (`chip-inline.status-*`, `chip-inline.severity-*`, `.dot`/`.runtime-dot`, `.live-tag`).
- Card variants: `.card`, `.card-lift`, `.pulse-scroll-card`.
- Inline-style policy: data-driven values stay inline; layout/spacing belong in CSS classes; rem units excluded from the system.

**Pulse view closure:**
- Unified card chrome across all 4 panels (Topic Coherence, Runtimes, Recent sessions, Stale alerts) — same `pulse-scroll-card` + `pulse-scroll-body` wrapper, same row chrome (8px 14px padding + 1px border-bottom + no border-radius), same hover treatment.
- KPI cards became navigable (`Kpi` + `KpiSparkline` accept optional `to` prop → render as `Link` with `kpi-clickable`).
- PulseSkeleton refactored to match populated layout (was using generic `.card` without scroll wrapper or grid areas → caused reflow on data arrival). Zero layout shift now.
- Toast wired into `dismissAlert`, `snoozeAlert`, `postMerge`, `setBucket` for proper async-action feedback.

**Documentation:** `src/ui/components/README.md` is now the canonical design-system reference. 10 sections: component inventory, drawer pattern, pagination, clickable rows, row states, empty states, action chips, formatting, page layout, confirmation dialog, tooltip, toast, forms, inline-style policy, tokens, buttons, z-index scale, design rules, icons, status indicators, card variants, rule-of-three for future extraction. SessionDrawer exemption documented inline. Future drift gets caught at the component or class boundary, not via CSS sleuthing.

**Bundle impact:** CSS 45.4KB → 49.0KB (+3.6KB for tokens, new component styles, comments). JS 292KB → 297KB (+5KB for Toast/Confirm/Tooltip/Drawer/Pagination/FilterGroup/rowProps/fmt modules). Net cost for real functionality, not bloat — 6 components, 4 lib modules, design system docs.

**Verified live:** focus management (drawer open → focus moves to first non-close focusable; close → focus restored to trigger); z-index scale (drawer:60, drawer-bg:50, palette:80, toast:100); form invalid border (danger orange); tooltip rendering with z-90; canonical row chrome across all four Pulse panels.

**Decisions made:**
- Rule-of-three for component extraction: don't build Palette or generic Popover yet (only one of each); extract when third instance lands.
- SessionDrawer stays standalone — arrow-key nav + supersede palette + kebab menu + skeleton-outside-body would force too many escape hatches into the Drawer wrapper.
- Two error UX layers: `<div className="muted error">` for page-level, `<p className="form-error">` for field-level. Don't migrate the 12 legacy `<p className="muted error small">` callsites in one sweep — incremental.
- 9px/12px/14px/16px/24px font-sizes that don't match existing tokens stay inline as intentional outliers — 1-2px nudges to nearest token would be visible.
- No focus trap inside drawers — initial focus + return focus only. Add trap if WCAG demand surfaces.
- No keyboard shortcut convention or scroll restoration this pass — feature decisions, not standards drift.

**Next priorities:** Settle this layer into actual use. Migrate remaining legacy error-message callsites incrementally. Watch for the third Palette or Popover instance to trigger extraction. Consider accessibility pass on Pulse (aria-labelledby on cards) if screen-reader use becomes a target.

## 2026-06-09 - Agent self-improvement signals: capture, aggregate, recall

Shipped the full "agent self-improvement signals" feature (spec + plan in `docs/superpowers/`). Coding harnesses emit a portable `nlm.signal` event; NLM stores it in a distinct append-only lane, aggregates threshold-gated failure modes, and recalls a "Known failure modes for this repo" block into the agent prompt at session start. Built TDD across six layers, each two-stage reviewed; final holistic review passed (776 tests, typecheck + build green).

**Store (distinct kind):** `SignalStore` port + `Sqlite`/`Pg` adapters (append-only, idempotent on a deterministic id, no supersedence, no embeddings). Migration `017_signals.sql` + pg parity. Wired into `Storage` (not `StorageContext` - signals never join a transaction). Per-install scope id (`~/.nlm/install-id`) stamped server-side.

**Ingest (two transports):** `normalizeSignal` (boundary validation: kind/outcome throw, producer/model/repo soft-default; deterministic `sig_<hash>` id). HTTP `POST /api/signal`. Session-embedded: the Pi adapter recognizes `type:"custom"` / `customType:"nlm.signal"` entries (real `pi.appendEntry` shape, payload under `data` - the spec's `appendCustomEntry`/`custom_message` prose was wrong) and the scheduler drains them before classify, fail-open.

**Aggregate + recall:** pure `aggregateFailureModes` (fail-rate >= 20% over n >= 10 in a 14d window, both configurable); deterministic `buildFailureModeBlock` (no LLM on the hot path). `GET /api/signals/failure-modes` + `GET /api/signals/stats`. Injected at Claude Code SessionStart and by a Pi `before_agent_start` consumer extension (repo + model scoped).

**Surfaces:** `nlm improve` CLI report + recommendations (surface-only, no auto-act); failure-modes panel on the Recall UI page. Config: `NLM_SIGNALS_ENABLED` (default on; `0` disables both ingest transports), `NLM_SIGNAL_RETENTION_DAYS` (default 90; scheduler prunes raw beyond it). Local-only, per-install isolated.

**Reference producer/consumer** in the separate pi-sandbox repo (branch `feat/nlm-signals`): the `quality-gate` extension emits `nlm.signal` per step + on exhaustion; the `nlm-failure-modes` extension injects the recall block.

**Files:** new `src/ports/signal-store.ts`, `src/core/storage/{sqlite,pg}-signal-store.ts`, `src/core/signals/{install-scope,ingest-signal,aggregate,failure-mode-recall,recommend}.ts`, `migrations/017_signals.sql`; touched `src/shared/types.ts`, `src/ports/{storage,transcript-adapter}.ts`, `src/core/storage/{sqlite,pg}-storage.ts`, `src/core/adapters/pi.ts`, `src/core/scheduler/scheduler.ts`, `src/http/app.ts`, `src/hook/session-start-hook.ts`, `src/cli/nlm.ts`, `src/ui/{lib/api,pages/Recall}.tsx`, `migrations/pg/001_initial.sql`, `README.md`.

## 2026-06-09 - 0.6.0: integrate PR#2 (recall/classifier) with signals, ollama default, publish

Reconciled two streams that had diverged from origin/main - PR #2 (recall/classifier specs A-G.2: query rewriting, recency weighting, miss log, fact corroboration, hook fact injection) and the agent self-improvement signals feature - into one main, and shipped 0.6.0.

**Integration.** Merged spec-a-qwen3-default into the signals-bearing main. Clean text-merge (the two features touched disjoint regions of the 5 shared files), but the full `npm run typecheck` (src + tests) surfaced three breaks a clean merge hid: a signals scheduler stub missing PR #2's new `LLMClient.rewriteForRecall`, plus two latent type errors PR #2 had shipped in its own tests (`related-facts.test.ts` imported `FactQuery` from the wrong module; `miss-detect.test.ts` set a non-existent `id` on `ToolUseBlock`) - invisible to PR #2's src-only `tsc --noEmit`. Both recall paths coexist (PR #2 "Known facts" pointer block + signals "Known failure modes" SessionStart block are disjoint code paths). 877 passed / 36 skipped / 0 failed.

**Classifier default flipped to ollama.** The fallback was `?? "deepseek"` while the comment above it, the model default (qwen3:4b), the README, and the local-first positioning all said ollama. Unset `NLM_CLASSIFIER` now selects ollama (key-free); deepseek still available via env.

**Docs + hygiene.** Clarified Hermes (WebUI) vs Hermes Agent (NousResearch CLI) in README + docs/hooks.md (and fixed a wrong config.yaml claim); noted SessionStart's failure-mode injection. Scrubbed internal names + personal paths from public/shipped files (the example pi-extension name reached the npm tarball). Security audit: no credentials in tree or 308-commit history.

**Quality eval.** `npm run eval:signals` (scripts/eval/signals-eval.ts) + docs/eval-signals.md - drives the real pipeline against a 440-signal corpus; all meaningfulness criteria pass (correctness, precision/no-nagging, scoping, recommendations, ranking, idempotency).

**Repo cleanup.** PR #2 auto-closed as merged; deleted 11 stale local branches (signals/integration scaffolds + 7 superseded phase-* exploration branches; tip SHAs recorded in session). Wave 1 minor dep bumps (cleared 2 of 7 audit vulns). Published 0.6.0, tagged v0.6.0.

**Follow-up:** Wave 2 major dep upgrades (React 19, Vite 8, Vitest 4 [clears remaining critical vuln], TS 6, Commander 15, Zod 4, better-sqlite3 12) - NocoDB task #283.

## 2026-06-10 - Soundness audit + supersedence/scan-path fix wave (4 commits, unpushed)

Three-pillar codebase audit (agent memory, observability, supersedence) run by the orchestrator with Haiku validation agents, followed by Opus/Haiku implementation of the critical findings. Findings tracked as NLM Tasks #289-296.

**Flagship finding: every resumed session on SQLite superseded itself.** scanOnce's SQLite path lacked the self-id guard the PG path had; deterministic session ids meant a grown transcript re-ingested under the same id, and insertSession wrote a self-loop edge then marked the row superseded. Live DB had 181 self-edges out of 185 superseded sessions (2,944 total) - provenance-integrity and Pulse counts were computed on poisoned data, and Thread dimmed 181 current sessions. Fixed in `c4834f0`: guard in scanOnce + defense-in-depth in both insertSessions + repair migration `018_repair_self_supersede.sql` (verified on a /tmp copy: 181→0 self-edges, 185→13 superseded; the 13 legitimate chains preserved). PG has no version-gated migration runner, so the PG repair file is a one-shot operator-applied script.

**PG scan path lost sessions on classify failure** (`ea03424`): scanOncePg upserted adapter_state before classification, so a classify timeout made the size-unchanged check skip the file forever. adapter_state now records only after successful insert (recordClassifiedPg), recordFailedPg RETURNING gives real failure counts in logs. Bonus latent bug found by live-PG testing: pg returns BIGINT file_size as a string, so the unchanged-size check was always false - PG re-classified every file every tick.

**Cycle detection on markSuperseded** (`a206b82`): BFS over supersedes edges (depth-capped 100) on both backends rejects 2-node and transitive cycles; HTTP maps to 400. The SQLite txn-wrap gap from the audit was already closed.

**Recall now excludes superseded sessions** (`d9ee06b`): keywordSearch WHERE predicate both backends; semanticSearch post-KNN filter on SQLite (vec0 can't WHERE on aux columns) and HAVING on PG. Fact recall was already safe. Ordering mattered: this landed after the data repair, else 181 wrongly-superseded current sessions would have vanished from recall.

**Suite: 922 passed / 48 skipped** (baseline 877). PG-gated tests verified live against pgvector:pg16. Audit also filed: #292 low-confidence infinite re-classify loop (P1), #294 action-layer polish (P2), #295 UI design-system sweep - 31 inline styles + 2 rowProps accessibility gaps (P2), #296 three pre-existing PG-gated test failures (P2).

**Architectural note for next session:** four divergence bugs now traced to SQLite/PG parity-by-duplication. Consider extracting shared scan/store logic, and a distinct edge kind to separate mechanical re-ingest (`replaces`) from epistemic overturn (`supersedes`).

**Next:** Edward reviews + pushes the 4 commits, restarts daemon (migration 018 runs on boot), applies the PG repair script manually if/when a PG install matters. Then #292 → #295.

**Second wave (same day) - trustworthy-supersedence plan implemented (#297-#299):**

- **`nlm doctor` (#297, `244d96a`):** invariant self-verification - I1-I6 checks (self-loops, orphaned statuses, cycles, dangling edges, duplicate active facts, phantom adapter_state refs), CLI with `--fix` for the mechanically safe repairs, 24h scheduler watchdog surfacing violations as `integrity` alerts at dataset-build time. First live run immediately caught unknown corruption: 37 duplicate active facts (I5a) - filed #301. Known gap: I5 SQL breaks on PG's GROUP BY strictness (#302).
- **Supersedence split (#298, `11597c9`):** mechanical re-ingest now writes `replaces`/`replaced`; operator `markSuperseded` keeps `supersedes`/`superseded`. Recall excludes both. Doctor gains I2r. Migration 019 (table-rebuild CHECK widen via new `-- nlm:no-wrap` runner directive; PG one-shot script). Sanity check on prod copy: 187 superseded -> 0 superseded / 13 replaced - **every supersedence edge in the corpus was mechanical; zero operator supersedences exist to date.** Design doc: `docs/plans/2026-06-10-supersedence-split.md`.
- **Thread UI (#299, `203e8d7`):** replaced sessions collapse behind an "N earlier versions" affordance (pure `groupByReplaceChain` helper, unit-tested); superseded keeps dimmed-but-visible strikethrough treatment. Search/Pulse filter replaced entirely.

Suite: 957 passed / 62 skipped (audit-wave baseline 922). Seven commits on main, unpushed, awaiting review: `c4834f0` `ea03424` `a206b82` `d9ee06b` `a475d56` `244d96a` `11597c9` `203e8d7` (eight with the plan doc). On daemon restart, migrations 018+019 run in order and repair + reclassify the live DB.

**Remaining from the plan:** #300 stranger-recovery simulation (run after push + restart; seed corpus must include a deliberate operator supersedence since the real corpus has none). Open follow-ups: #292 low-confidence loop, #294 action polish, #295 UI sweep, #296 PG suite failures, #301 duplicate facts, #302 doctor-on-PG fix.

**Third wave (same day) - P1 burn-down + stranger validation (#292, #300-#302):**

- **#292 (`dc61085`):** low-confidence classifier results now record adapter_state (file_size advanced, session_id preserved via ON CONFLICT omission) - kills the every-30-min re-classify loop on both backends.
- **#302 (`48855ee` + orchestrator correction `0d5314b`):** doctor I5a now PG-legal. The agent's first rewrite silently changed count semantics (87 member facts vs 37 conflicting pairs on live data) and claimed otherwise in the commit message - caught in review by empirical comparison; corrected to MIN(id) aggregate. Lesson: portability rewrites of GROUP BY queries need a count-pinning test.
- **#301 (`4458a16`):** duplicate active facts root-caused as a LIVE SQLite-only bug - divergence #5 from backend parity-by-duplication. SQLite's supersedence loop collapsed only the single most-recent prior (LIMIT 1); PG was already set-wise. Multi-pass backfill + ON DELETE SET NULL un-supersede created states the loop could never heal. Fixed set-wise + migration 020 (window-function winner per pair, idempotent; verified independently on a live copy: 37→0 pairs, 6913→6863 active, 0 dangling).
- **#300 stranger simulation: PASS, with a release-blocker found before the stranger even ran.** Phase 1 (sandboxed timed install from GitHub HEAD) discovered `migrations/` was never in the npm files array - `runMigrations` scandirs it in the storage constructor, so EVERY fresh npm install of every published version crashes on first storage command (reproduced on pristine nlm-memory@0.9.2; `nlm upgrade` would have killed the production daemon too). Fixed `b90b816`. Phase 2: a context-free agent recovered the full 5-session pgvector decision arc including the operator overturn in ~5-6 minutes, README+CLI+API only, current-vs-historical state stated correctly, verdict "I'd keep it installed." Full report: `reports/stranger-sim/2026-06-10-recovery-simulation.md` (`515a88d`). Product-shaping find: superseded sessions are invisible in recall exactly when investigating a decision - filed #303 (recall supersedence surfacing, P1) + #304/#305 (ergonomics/README).
- **Release pipeline (`4d183ab`):** tag-triggered GitHub Actions publish with npm provenance + auto GitHub Release. Edward's one-time setup: trusted publisher on npmjs.com. Release ritual: `npm version minor && git push --follow-tags`.

Suite: 962 passed / 62 skipped. All pushed; origin at `515a88d`. **Next release (0.10.0) is now urgent:** the published 0.9.2 is dead-on-arrival for new installs until the packaging fix ships. Open: #294, #295, #296, #303, #304, #305.

**Fourth wave (same day) - releases + production repair + #303/#304/#305:**

- **v0.10.0 published** (manual, `[skip ci]` tag): the packaging fix + all migrations + doctor + supersedence split. GitHub Release notes lead with the install-crash fix and disclose the data-repair migrations explicitly. Fresh-install smoke test on the published package: clean boot, 20 migrations applied.
- **Release pipeline proven on v0.10.1**: trusted publisher (OIDC) configured on npmjs.com, CI published with SLSA provenance attestation in 68s. Release ritual is now `npm version X && git push --follow-tags`. Local npm token can be revoked.
- **#304/#305** (`6906471`, `c6f63d7`, correction `e09316e`): nlm config get, recall --mode docs, README ergonomics (port note, facts-empty hint field, headless start). Review catch #2 of the day: the agent built a duplicate POST /api/cite when /api/citation/explicit already existed undocumented - removed the duplicate, documented the real route. Lesson: when a friction report says "no documented X", grep for X before building X.
- **#303 shipped in v0.11.0** (`d313f68`): recall supersedence surfacing, option C. CLI/MCP include superseded hits down-ranked (0.7 multiplier in finalize) with status + supersededBy in the result shape; HTTP ?include_superseded opt-in default-off; hook exclusion pinned by regression tests; replaced excluded everywhere. Verified by live-firing the stranger corpus: the previously-invisible decision session now surfaces badged `[SUPERSEDED -> successor]` in the recall list.
- **Production daemon: 0.5.22 -> 0.11.0.** Migrations 018/019/020 ran on the live DB; `nlm doctor` all-PASS; 0 self-loops (was 181), 2,954 closed / 13 replaced / 0 superseded; duplicate facts collapsed. The live ingest bug that was still writing corrupt rows daily is gone from production.

Suite: 985 passed / 65 skipped. Origin + npm + production all at v0.11.0. Remaining open: #294 (action polish), #295 (UI sweep), #296 (PG-gated test failures) - all P2.

_Older entries archived in CHANGELOG-2026.md_

## 2026-06-16 - #219/#220: Storage-port registry accessors (storage.sources / storage.providers)

PR #8 merged (`7d16c0a`). Then the Storage-port accessor refactor on `feat/storage-registry-accessors` — the structural change that lets registry callers stop touching `rawDb()`/`pgPool()` to *construct* a registry.

- **New ports:** `SourceRegistryPort` + `ProviderRegistryPort` (async interfaces, co-located with their adapters since the `SourceRow`/`ProviderRow` domain types live there). Both SQLite and PG registries `implement` them. Following the SignalStore/FactStore convention, the SQLite registries are now declared `async` (sync bodies, async signatures) so one interface spans both backends.
- **Storage port gains `readonly sources` + `readonly providers`**, constructed once inside `SqliteStorage.create` (over the shared connection) and the `PgStorage` constructor (over the pool). Callers now read `storage.sources` / `storage.providers` instead of `new SourceRegistry(storage.rawDb())` / `new PgSourceRegistry(storage.pgPool())`.
- **Rewired:** `buildStack` (dropped the `instanceof PgStorage` construction branch + the `SqliteStorage` cast) and all four `connect`/`disconnect` CLI sites (cursor/windsurf) — `connectCursor`/`connectWindsurf`/`disconnect*` are now `async (registry: SourceRegistryPort)`. `buildAdapters` takes `SourceRegistryPort`.
- **Asymmetry preserved:** provider seeding stays SQLite-only (`if (providers instanceof ProviderRegistry) await providers.seedDefaults()`) — `seedDefaults` is deliberately NOT on `ProviderRegistryPort` because it bridges from the local `DEEPSEEK_API_KEY` env, wrong for a hosted multi-tenant PG. `getToken` is likewise off `SourceRegistryPort` (only the unported scheduler reads it).
- **`TODO(#215a)`: 9 → 3** (all in nlm.ts: the ingest-deps cast `:236`, scheduler PG path `:327`, backfill PG path `:636`). Registry/connect construction hatches fully gone.
- **Tests:** `source-registry.test.ts` + `provider-registry.test.ts` converted to `async`/`await` and now exercise `storage.sources`/`storage.providers` (the accessor path). Full suite **1090 pass**; PG suite **8/8** vs a fresh `pgvector/pg16` container; typecheck clean.
- **`pgPool()` not yet removable:** still used by `nlm check-invariants` (dual-backend, has both paths) and blocked on the scheduler/backfill/ingest PG paths. Those + the eventual hatch deletion are the #220 tail.

## 2026-06-16 - #220 CLOSED: PG fact-backfill — the last TODO(#215a) site

`feat/pg-backfill` (PR). The offline `nlm backfill-facts` command now works on PostgreSQL, clearing the final `TODO(#215a)` marker — **0 remaining** in `src/`.

- **Pushed the SQL into the adapters** (matching the arc's port philosophy): new `SessionStore.listBackfillCandidates(filter)` on both `SqliteSessionStore` and `PgSessionStore` returns the eligible-session set (started_at < cutoff, non-empty body, `from` resume marker, `reprocess` toggle for the `NOT EXISTS facts` exclusion). `backfill-facts.ts` no longer touches `store.rawDb()` — it calls the port method polymorphically.
- **Added `PgSessionStore.insertFactsForSession`** — the standalone PG counterpart of the SQLite version (DELETE-by-session + per-fact INSERT + batch supersedence in one transaction, best-effort fact embedding after commit). Mirrors the factSink path from the live-ingest PR.
- **`backfillFacts`** widened to the backend union; the `insertFactsForSession` call narrows on `store instanceof PgSessionStore` (same-backend `factStore` cast, as in the scheduler/ingest PRs). `nlm.ts` backfill site: dropped the `as SqliteSessionStore`/`as SqliteFactStore` casts + the TODO.
- **`pgPool()` scope documented down:** all #215a escape-hatch callers (registries, actions, scheduler, ingest, backfill) are ported. The one remaining caller is `nlm check-invariants`, which runs backend-specific invariant SQL via `runChecksOnPg`/`applyFixOnPg` — a deliberate dual-backend diagnostic API, not an un-ported leak. The `@deprecated` tag is replaced with that explanation.
- **Tests:** new `backfill-facts.pg.test.ts` (gated on `NLM_PG_TEST_URL`) — writes facts for fact-less sessions, skips-existing + resumes (`reprocess=false`), and supersedes on a new value across sessions. **3/3 + wider PG suite (14) green** vs a fresh `pgvector/pg16` container; SQLite backfill regression unchanged (11); full default suite **1090 pass**; typecheck clean.
- **#220 + #219 close** once this merges: every `rawDb()`/`pgPool()` escape hatch tracked under #215a is now either ported to the Storage port or is a documented legitimate dual-backend path.

_Older entries archived in CHANGELOG-2026.md_

## 2026-06-16 - #324 CLOSED: runtime-test the webhook ingestSession PG branch

`test/324-webhook-pg-ingest` (PR). The webhook push path — `ingestSession()` in `src/core/ingest/ingest-session.ts` — was typecheck-verified but never exercised against live PostgreSQL; the `deps.store instanceof PgSessionStore` branch (lines 114-116) had no runtime coverage. The prior `pg-ingest.pg.test.ts` covers `insertSession` directly and a full `ScanScheduler.tick()`, but never calls `ingestSession()` itself.

- **Two new tests** in `pg-ingest.pg.test.ts` (gated on `NLM_PG_TEST_URL`, reusing the file's `FactClassifier`/`StubEmbedder`): (1) `ingestSession()` classifies → extracts facts → persists session + facts through the PgSessionStore branch (asserts session label, `transcriptKind: "webhook"`, and the fact lands with the right `sourceSessionId`); (2) below the 0.3 confidence floor it short-circuits and persists nothing.
- **Result:** `pg-ingest.pg.test.ts` **5/5 green** vs a fresh `pgvector/pg16` container on :5544; wider PG suite green when run serially. No production code changed — test-only.
- **Two pre-existing issues surfaced (NOT #324, unrelated to this change):** (a) 7 typecheck errors under `tsconfig.test.json` — `sourceQuote: null` in `ClassifyResult.facts[]` literals across `backfill-facts.pg.test.ts` + `pg-ingest.pg.test.ts`, plus an `exactOptionalPropertyTypes` mismatch in `supersede-fact-handler.test.ts`; (b) `storage.pg.test.ts` "rejects nested withTransaction calls" fails consistently in isolation — the contract test fires the inner `withTransaction` with `void` and a non-async outer callback, so the (correct) nesting rejection becomes an unhandled rejection instead of propagating. Both are test-only; product behavior is correct.

## 2026-06-22 — production-readiness re-measurement + #351 follow-up (orphan vec0 embeddings)

Re-measured the move off the audit's 2/5 against the live store, and root-caused a regression the #351 fix had only half-closed.

- **Re-measurement (evidence, not a re-audit):** citation log 835→66 (0 fixtures, #349); supersedence cycles 764→0 and superseded-fact ghosts 4,053→0 (#351). Real, on the live store.
- **New finding — the #351 fix never reached production.** bug-1 (delete-embeddings-on-replace) and bug-2 (single-winner collapse) landed only in `SqliteFactStore.ingestSessionFacts`, but the live ingest path is `SqliteSessionStore.insertSession` (`scheduler.ts:290`), which inlined a duplicate copy never patched (`insertFactsForSession` too). Measured: **4,074 orphan fact-embedding vectors (30.7% of the index)** with no backing fact, stealing kNN slots in `runSemantic()`; the per-fact collapse could also still cycle. The "change one, change the other" comment was not a safeguard.
- **Fix (PR #38):** extracted `ingestSessionFactsInTxn()` as the single source of truth; both inlined paths delegate to it inside their txn. 5 RED-first tests on the production `insertSession`/`insertFactsForSession` paths. Suite 1274 green, typecheck clean.
- **Backfill:** `scripts/repair-orphan-fact-embeddings.mjs` (idempotent; the facts-table walk in `repair-fact-embeddings.mjs` can't see rows that no longer exist). Copy-tested then run live: **4,074 → 0**, fact index now **100% recall-eligible (was 69.3%)**, invariants clean (`I5a:3` pre-existing). Daemon restarted with the fix; semantic fact recall verified live. Backup: `~/.nlm/canonical.sqlite.bak-pre-orphan-repair`.
- **State:** corpus-health + hook-honesty up on real numbers; gate stays closed on TELEMETRY (1/5, signals=5, #352 untouched). Next: #352 (telemetry foundations) → #353 (retention) → #354 (exemplars), each feature-scale (design + sign-off first).

## 2026-06-24 (cont.) — #367 workstream Plan B EXECUTED + merged; Plans C & D written + critically-reviewed

**Changes:** Plan B (SURFACING) of #367 executed via subagent-driven-development (6 TDD tasks, Sonnet implementers + Opus per-task reviews + Opus whole-branch review) and merged to local main (`51ff4e7`, `--no-ff`). Delivered: `Session.workstreamId` projected onto `listByDateRange` (sqlite+pg); work-digest topic provider attributes time to the resolved workstream LABEL (fallback preserved for unbound sessions); stable `workstream_id` on `byTopic[].meta` (telemetry seam §11); `composeWorkstreamRecall`; `recall_workstream(idOrLabel)` MCP tool + handler + CLI (both HTTP+stdio transports); optional `workstream` filter on `recall_sessions` (MCP+CLI parity via a `resolveWorkstreamSessions` resolver injected into RecallService). Then WROTE + critically-reviewed + committed Plan C (lifecycle: `docs/superpowers/plans/2026-06-24-workstream-lifecycle-plan.md`, `7469adc`) and Plan D (seed/backfill/flip: `2026-06-24-workstream-seed-backfill-flip-plan.md`, `800e9fc`).

**Decisions:** Followed rule #9 (each plan = a fresh session: write warm, execute fresh) — executed Plan B here, wrote C+D at full quality while the spec was loaded, handed C/D EXECUTION to fresh sessions. Plan B merged with individual atomic commits preserved (matching Plan A), not squashed. Plan C's merge-suggestion shipped as an on-demand computed tool (no new table/scheduler) — Opus critical-review ruled this an acceptable YAGNI departure (spec §7 "cleanup, not a gate", no persistence consumer). Plan D's critical-review caught a CRITICAL no test would catch: tune-matcher read `sctx.entities` but `openSessionContext()` returns a string with no `.entities` — would have silently zeroed entity-Jaccard and CORRUPTED the gold-derived thresholds; fixed (source via `getEntities`), plus mandated a `scoreCandidates` extraction (spec §15 one-source-of-truth) and split `binding_source='backfill'` so the reversal query stays surgical post-flip.

**State:** Plan B on local main, 1427 tests pass (the lone `cli-work-digest` error is the pre-existing CLI-subprocess flake — confirmed reproduces in isolation 3/3 passing, not a regression), typecheck + `build:server` clean, public-repo hygiene scan clean. Binding flag still OFF (Plan B is behavior-neutral until Plan D seeds+tunes+flips). Plans C+D committed to local main. main is **26 commits ahead of origin, UNPUSHED** — Edward controls the public push; daemon restart + flag flip happen on Edward's machine post-push. SDD ledger (`.superpowers/sdd/progress.md`) holds the full per-task recovery map.

**Next:** EXECUTE Plan C (fresh session, additive lifecycle tools, low-stakes) then EXECUTE Plan D (fresh session — R3 gold set must be hand-labeled INDEPENDENTLY of work-topics.json; do NOT flip until gold numbers meet min-recall; Edward in loop for the R6 flip). Deferred minors are folded into Plan D's flip wave (Plan A: matcher boundary tests + bind.ts orphan comment; Plan B: recall_sessions merge-chain filter test via real wiring). Still pending: #368 Settings UI embedder/classifier picker.

## 2026-06-25 — #367 workstream Plan C (LIFECYCLE) EXECUTED + merged to local main

**Changes:** Plan C (lifecycle) of #367 executed via subagent-driven-development (6 TDD tasks, Sonnet implementers + Opus per-task reviews + Opus whole-branch review) and merged to local main (`15f1ffa`, `--no-ff`, 7 atomic commits). Delivered the workstream *mutation* surface: `WorkstreamStore.{setLabel,setStatus,merge}` (sqlite+pg parity; `merge` = supersedence pointer + entity-union, sqlite transactional / pg sequential fail-safe order); a shared module-private `resolveWorkstream(idOrLabel → live merged_into survivor)` helper; and five operator MCP tools + CLI commands — `rebind_session`, `merge_workstreams`, `rename_workstream`, `retire_workstream`, `list_merge_suggestions` (on-demand pure scorer in `core/workstream/merge-suggest.ts` — shared-entity Jaccard + shared-session Jaccard + normalized-Levenshtein label similarity). No schema migration (all columns pre-exist from Plan A); hot-path-free. Plus a fail-loud `--min-score` boundary guard (`42fce0d`).

**Decisions:** (1) `resolveWorkstream` extracted as one-source-of-truth helper — a Task-3 implementer inlined the resolution logic ("YAGNI, used once"); the controller overrode with cross-task knowledge that Tasks 4/5/6 all reuse it (a per-task reviewer in isolation can't see that). (2) `list_merge_suggestions` ships on-demand (no scheduler/persisted table) — accepted YAGNI departure from spec §7, flagged for review. (3) Plan D runs in a FRESH session (execute-fresh discipline; the ~50-session gold-set labeling needs fresh context).

**State:** main **34 commits ahead of origin, UNPUSHED** — Edward controls the public push. Full suite 1446 pass + 1 pre-existing `cli-work-digest` CLI-subprocess flake; typecheck clean. A transient `http.test.ts` tmpdir race (recall query-log path) under full-parallel load was proven a pre-existing flake — merged tree byte-identical to the reviewed branch HEAD, passes 70/70 in isolation, and Plan C never touches that path. Daemon rebuild + restart DEFERRED to post-push (the 5 new MCP tools register then). SDD ledger (`.superpowers/sdd/progress.md`) holds the full per-task recovery map.

**Next:** Execute Plan D (`docs/superpowers/plans/2026-06-24-workstream-seed-backfill-flip-plan.md`) — 5 TDD code tasks (buildMatchInputs extraction, seed loader, scoreCandidates+tune-matcher, match-only backfill with `binding_source='backfill'`, gold thresholds + Plan A boundary tests) then the R1–R6 runbook; R3 gold-set hand-labeling (independent, from each session's OWN transcript) before backfill; R6 `NLM_WORKSTREAM_BIND=true` flip is irreversible, Edward-gated, post-push, gated on gold numbers meeting min-recall. No corpus re-embed (embedder unchanged).
## 2026-06-25 (cont.) - #367 Plan E PIVOT - embedding matcher falsified, classifier-naming built + merged to local main

**Changes:** Before building Plan E (entity-scoring + iterative bootstrap cascade), ran the design's Q2 reversible full-corpus dry-run read-only against the live DB (faithful to `buildMatchInputs`/`scoreCandidates`, query embeds via LM Studio, neighbors via real vec0; throwaway harnesses `scripts/eval/_r3e-*.ts`, untracked). It FALSIFIED every embedding approach: cascade floods to 97.6% corpus binding all 33/33 gold negatives (10-16% precision); abstain single-pass 50% precision @ 5.9% recall; anchor-centroid+abstain (best) ceilings at 57% @ 24%. Root cause: session embeddings cluster by ACTIVITY-TYPE (code-review/refactor/research), NOT project, so negatives sit at the same cosine as positives - no gate separates them. Validated the pivot: classifier NAMES the project (label+summary only, conservative floor) = 71% precision, ZERO wrong-project binds, 94% neg-abstain. Edward confirmed "classifier-naming, retire embedding bind." Built it via subagent-driven-development (7 TDD tasks, Sonnet impl + per-task Opus/Sonnet review + Opus whole-branch review + a 3-item fix wave): `nameWorkstream` on the LLMClient port + DeepSeek/Ollama clients + ClassifierBox; pure `decideWorkstreamByName` (name/alias match, abstain by default, never creates); `bind.ts` + scheduler rewired; name-only reversible backfill (`binding_source='backfill'`, dry-run gated); shared `work-topics.ts` (parseWorkTopics + aliasToLabelMap + aliasesFor); `build-classifier.ts`. Deleted the embedding matcher (`match.ts`, `build-match-inputs.ts`, `thresholds.ts`, eval tuner + `dump-matcher-candidates`). Merged to local main `11e31bb` (`--no-ff`, 9 commits + fix wave).

**Decisions:** Retire embedding binding entirely (kept schema, lifecycle tools, seed loader, locked gold). Forward bind `binding_source='classifier'`, historical `'backfill'` (surgical reversal). Default `createOnNoMatch=false` (abstain to the seeded set). Thinking-model token budget is load-bearing: qwen3.5 with `max_tokens=300` returns EMPTY content (all budget on hidden reasoning) - DeepSeek uses `classifyMaxTokens=8192`, Ollama uses `think:false`. Superseded the old cold-start design doc (kept as the falsification record). `DEFAULT_THRESHOLDS`/embedding scoring gone - binding is now a content decision, not a vector-similarity score.

**State:** main 12 ahead of origin, NOT pushed (Edward controls public push). Flag `NLM_WORKSTREAM_BIND` stays OFF. Whole-branch gate green (typecheck + build:server clean, 1456 tests pass + pre-existing untouched `cli-work-digest` flake). Deferred non-blocking follow-ups: M1 shared parseLongestLabel helper (DeepSeek+Ollama); M3 repoint nlm.ts to shared `build-classifier`; M5 tighten scheduler-bind integration assertion; M7 classifier-box<->ollama-client import cycle. Lesson: de-risk a design's central hypothesis with a read-only full-corpus measurement BEFORE building - the dry-run inverted the design (cascade over-binds, it doesn't under-bind) and the separability test showed the embedding signal is fundamentally activity-typed, redirecting to the classifier.

**Next:** Task 8 runbook (Edward-gated, post-push): tune the naming prompt + token budget + alias/entity hints + full-transcript content vs the LOCKED gold (`~/.nlm/eval/gold-matcher.jsonl`, reuse) to push recall above the 29% floor while holding precision; then backfill the 4276 corpus (local Studio lane, reversible), verify `nlm work-digest` reads ws labels on 2 days, then flip `NLM_WORKSTREAM_BIND=true` + daemon restart. Plan: `docs/superpowers/plans/2026-06-25-workstream-classifier-naming.md`; design: `docs/superpowers/specs/2026-06-25-workstream-classifier-naming-design.md`.

## 2026-06-25 (cont.) - #367 Plan D runbook (R1-R3) + matcher not-flip-ready + Plan E designed

**Changes:** Ran the Plan D rollout runbook against the live `~/.nlm/canonical.sqlite`. R1 preconditions pass (flag OFF, embedder live via LM Studio nomic-v1.5). R2 seed: 15 workstreams + 84 entities (DB-verified, alias-grouping correct). R3 gold set built (50 sessions, locked at `~/.nlm/eval/gold-matcher.jsonl`) via 5 fan-out INDEPENDENT labelers (transcripts + label vocab only, never the alias map) + mechanical label->id assembly. Fixed 4 live-surfaced script defects: `3c3d949` shared `buildEmbedder()` (eval/backfill were hardcoded to a torn-down Ollama; now embed via the configured LM Studio provider), `4336d72` space-safe entrypoint guard (`fileURLToPath`, was no-op'ing `main()` on the spaced repo path) + `parseWorkTopics` alias-map shape, `69b4bc9` dump-matcher `started_at` (dead `ts` column). Plan E design written, scrubbed, committed (`3e73e70`). All pushed (main == origin).

**Decisions:** STOPPED at the spec §17 gate - matcher NOT flip-ready. Cold-start: 0 bound sessions -> the semantic half of the score is dead -> score collapses to entity-Jaccard, which under-scores large session entity-sets. On the gold set, positive top-scores (0.015-0.20) overlap negatives (0.013-0.115) with no separation; default `high=0.55` would bind nothing. Did NOT run R4/R5/R6; binding flag stays OFF (behavior-neutral). Edward chose "improve matcher then retry" -> Plan E: overlap-coeff/IDF entity scoring (§18) + iterative bootstrap backfill + re-tune vs the locked gold. Classifier context bumped 8192 -> 32768 (was too tight for the thinking model's input+output; helps R6 forward binding). Net-new "PolySignal" scrubbed before the public push; pre-existing public leaks (Studio IP in classifier-eval.ts, PolySignal in prompt.ts/tests, home path in an older plan doc) flagged for a separate cleanup pass.

**State:** main == origin (pushed). Binding OFF. Gold set locked + reusable. Lesson: operational scripts that touch real data/env/paths need a live smoke gate - all 4 defects passed SDD review because tests used synthetic fixtures matching the plan's (wrong) assumptions (ingested to `Ventures/nlm-memory/learnings.md`). Plan E task = NocoDB #370.

**Next:** Execute Plan E in a FRESH session (writing-plans -> subagent-driven-development). FIRST quantify whether the iterative bootstrap cascades on the full 4234-session corpus (reversible dry-run, design Q2). Then E1 entity scoring / E2 bootstrap backfill / E3 re-tune, then R4 backfill / R5 verify digest / R6 flip (Edward-gated, gated on re-tuned gold numbers). Design: `docs/superpowers/specs/2026-06-25-workstream-matcher-coldstart-design.md`.

## 2026-06-25 (cont.) - #367 workstream Plan D (SEED/BACKFILL/FLIP) code merged to local main

**Changes:** Plan D code phase executed via subagent-driven-development (5 TDD tasks + 1 Plan B closure test, Sonnet implementers + per-task Opus/Sonnet reviews + Opus whole-branch review) and merged to local main (`a7828ef`, `--no-ff`, 6 atomic commits). Delivered the real-data rollout machinery (no new abstraction): (1) `buildMatchInputs` extracted from `bind.ts` so runtime, eval, and backfill share ONE matcher-input pipeline (spec §15); (2) `scoreCandidates` extracted from `match.ts` so scoring lives in one place; (3) seed loader `scripts/seed-workstreams.ts` (pure `parseWorkTopics` tolerating object-map and array shapes, idempotent create+upsert from `~/.nlm/work-topics.json`); (4) real matcher wired into `scripts/eval/tune-matcher.ts` (replaces the Plan A stub, sources entities via `getEntities`, reads raw `scoreCandidates[0]` for the threshold sweep); (5) match-only historical backfill core + CLI (`src/core/workstream/backfill-workstreams.ts` + `scripts/backfill-workstreams.ts`) binding `binding_source='backfill'`, never create, never LLM; (6) exact-boundary tests locking the `>=` HIGH / strict-`<` LOW operators + a `bind.ts` orphan-workstream comment; (7) Plan B closure, a `recall_sessions --workstream` merge-chain integration test via real wiring. `BindingSource` widened to `classifier|operator|backfill` (additive, free-text TEXT, no migration).

**Decisions:** (1) `DEFAULT_THRESHOLDS` left PROVISIONAL on purpose, the production HIGH/LOW values come from the R3 gold-labeling runbook step against the live DB which is not yet run; Task 5 Step 4 (the `thresholds.ts` edit) is deferred into R3. (2) Distinct `binding_source='backfill'` (not `'classifier'`) so the reversal `WHERE binding_source='backfill'` stays surgical and safe even post-flip when forward bindings accumulate as `'classifier'`. (3) Backfill matches on REAL entities (`getEntities` per session), never empty arrays, since empty entities would silently zero the entity-Jaccard half and corrupt matching (the same bug class Plan D's critical-review caught in tune-matcher). (4) No corpus re-embed (embedder unchanged, embedding space stable).

**State:** main is **41 commits ahead of origin, UNPUSHED**, Edward controls the public push. Full suite 1456 pass + the lone pre-existing `cli-work-digest` CLI-subprocess flake (proven: its 3 tests pass in isolation, the branch touches none of that file); typecheck + `build:server` clean. Merged tree byte-identical to the reviewed branch HEAD (`git diff --stat` empty). Binding flag `NLM_WORKSTREAM_BIND` still OFF (default), Plan D is behavior-neutral until the runbook seeds, tunes, backfills, and flips. SDD ledger (`.superpowers/sdd/progress.md`) holds the full per-task recovery map.

**Next:** R1-R6 runbook (controller/Edward operational, against the LIVE `~/.nlm/canonical.sqlite`, post-PUSH): R1 preconditions (flag OFF, daemon down, LM Studio nomic-v1.5 up); R2 seed; R3 hand-label ~50 sessions INDEPENDENTLY from each session's OWN transcript (NEVER `work-topics.json`), run tune-matcher, set `DEFAULT_THRESHOLDS`, commit; R4 match-only backfill; R5 verify work-digest reads workstream labels on the two validated days; R6 FLIP `NLM_WORKSTREAM_BIND=true` (irreversible, Edward-gated, gated on gold min-recall not a schedule). Daemon restart (`launchctl kickstart com.github.pbmagnet4.nlm-memory`) post-PUSH only.
