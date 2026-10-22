# nlm-memory CHANGELOG

## 2026-10-21 - Compact, budgeted MCP session discovery (T937)

**Changes:** `recall_sessions` now returns five compact hits within 8,000 formatted characters by default. Query-selected decisions/open questions, explicit omission counts, source expansion selectors, and scoped continuation cursors replace verbose unbounded hits. The existing ten-candidate retrieval window remains the default; widening it is explicit because it can change ranking. Paging detects changed candidate order and telemetry records only displayed IDs. Reused existing compact `get_session` and lossless transcript paging; no storage, provider, ranking algorithm or fact-recall changes.

**Results:** Typecheck/build and full npm suite pass (3,289 pass, three opt-in tests skipped). JSON/TOON, whole-window traversal, long escaped text, supersedence, cursor binding/change detection, scope-preserving expansions, degradation and actual-returned-ID telemetry are covered. Ten keyword queries against a migrated disposable live-corpus snapshot kept the same top-five IDs; median JSON size fell from 9,253 to about 3,800 characters. Two old responses exceeded 25,000; all new responses fit 8,000. This checks size/order, not independent answer quality or actual tokens. Local code/security review found no remaining issue after correcting the initial wider-window ranking change. No `.agent-quality.yml` is configured; npm CI checks ran directly.

**State:** Source implementation only. The installed 0.21.17 daemon still has the older all-or-nothing guard and schema; it was not changed or migrated. After Edward approved sending the landed diff, independent Muse Spark 1.3 xhigh code/security review returned zero findings. Review evidence is recorded with T937. No public release was made and no live corpus was written.

**Next:** Include this with the existing T803/T806 retrieval release, consistent backup/migration and live canaries. API and measured limits: `docs/context-retrieval.md`.

## 2026-10-16 - Required retrieval integrity and measured optional no-go (T806)

**Changes:** Tenant/workstream fencing, eligible exact semantic top-k, complete current-value probes, shared request budgets/embedding promises, bounded SQLite read workers, trusted attribution, and nullable literal UTF-16 source anchors with old-writer guards. Optional ranking, deltas and decision-model reranking remain off. Added frozen one-shot diagnostic entry and durable results/rulings.

**Results:** Typecheck/build pass; full suite with real PostgreSQL: 3,278 pass / three pre-existing opt-in live embedder skips. Four stale PG schema expectations fixed after the first full run. Preregistered 55 heldout literal cases: 1→5 sufficient, grouped95% delta interval [0,+19.35] points; six no-answer cases fail both arms. Source audit has zero verified quote/passage contradictions. Exact tokens, primary answer quality and power unavailable: no scientific promotion. Legacy anchor CPU and broad latency gates did not pass; see `docs/memory-retrieval-results.md`.

**State:** Required task reviews and final whole-branch/spec/security review pass; Low A1 is tracked in T810. Local landing is recorded in T806/git. Installed 0.21.17-t730 unchanged; deployment, consistent backup, migration and live MCP canary pending. No provider change, public publish or live database write.

**Next:** Authorized deployment and live canaries after backup/binary preservation; T810 tracks duplicate legacy-body hydration. T527/T679 remain open with measured source evidence.

## 2026-10-16 - Source-grounded SDD retrieval improvement plan (T805)

**Changes:** Added the measurable retrieval specification, ten-task SDD implementation plan and editable architecture diagram. The plan prioritizes source-grounded evaluation, tenant/workstream eligibility, semantic candidate completeness, exact-value ambiguity, shared request budgets and source anchors; optional ranking, evidence deltas and decision-model reranking require measured promotion. Linked from `docs/context-retrieval.md`.

**Results:** Independent critical review's holdout-selection and model-usage/capability findings were accepted, corrected and cleared in scoped re-review. Verified local links, ten ordered tasks/sixty unchecked steps, diagram XML/render and whitespace. No runtime tests or new performance gains are claimed for this documentation-only change.

**State:** Planning only, based on local main `e391597`. Implementation and installed daemon unchanged. Numeric improvement gates are proposed acceptance targets; final holdout stays sealed until preregistered candidate selection is complete. Each implementation task includes spec/code review and the release includes final branch review.

**Next:** Execute Task 1 in its own task worktree/SDD ledger to establish independent evidence-sufficiency and actual-token baselines before optimizing.

## 2026-10-16 - Compact structured memory context and source expansion (T803)

**Changes:** Added `recall_context` with current fact triples, source provenance, decisions/open questions, exact original passages, a bounded response, and targeted expansion references. Exact structured lookups skip session search and embeddings; default lanes preserve hybrid facts and keyword sessions without query-time generative calls. `get_session` now defaults to compact context and offers explicit versioned transcript pages. Retained semantic chunk positions, fixed lexical fact retrieval beyond the newest 500 rows (SQLite FTS5 / PG GIN), added a covering corroboration index, minified JSON, and regenerated hook guidance/bundles. No stored facts were rewritten or retired.

**Results:** On the frozen corpus, 122 held-out synthetic fact-topic queries improved keyword R@1 from 0 to 36.9%; hybrid R@1 stayed 73.0% and R@5 stayed 100%. No fact R@1 regression across tested splits/modes. Across 26 held-out source sessions compact context used 96.4% fewer response characters, with no errors or budget overruns; this is not a token-count or answer-correctness measurement. Corroboration counts matched across 10 alternating 12-triple batches; median lookup 93.38 ms to 0.044 ms. Independent review's single low-severity phantom-session-query finding was accepted and fixed.

**State:** Implementation is local; the installed daemon is unchanged. Tests cover source offsets, Unicode and changed-source paging, semantic-only passages, short identifiers, tenant isolation, old facts, conflicts, budgets, and telemetry. API contract and measurement limits: `docs/context-retrieval.md`.

**Next:** Release/deploy through the normal NLM installer to activate the new MCP tool and migrations; independently labelled answer-quality evaluation remains separate from the existing synthetic/citation ranking checks.

## 2026-10-15 - Polite classifier client: in-flight cap, re-touch dedupe, per-chunk budget, outage backoff (T720)

**Changes:** Every daemon classifier request goes through one limiter (`NLM_CLASSIFY_MAX_INFLIGHT`, default 1), chunks of an oversized session included; chunks now dispatch through it and each gets its own timeout once it holds a slot, with surviving chunks kept as a partial result. The scheduler hashes the normalized session text per source and skips a resumed source whose text is unchanged. Infrastructure errors (unreachable, reset, DNS, 5xx, timeout) defer the session with 30 s doubling to 10 min backoff, stop the tick, and never count toward the 3-strike ceiling; non-JSON and schema failures still do. `TickReport` gains `deferred`.

**Results:** Tests cover cap 1 and 2 across 3 chunks, a 5-chunk slow client exceeding one chunk's budget, touch-only and noise-append skips, append reclassification, and a 500-then-success recovery.

**State:** The dedupe hash and backoff clocks live in daemon memory, so a restart costs at most one extra classification per grown source. Clearing `adapter_state` rows still forces re-ingest.

**Next:** none.

Session-level log per session protocol. Cap: 10 entries — archive older to `CHANGELOG-YYYY.md` when exceeded.

## 2026-10-13 - Daemon log faults: daemon stalls, false integrity alert, git noise, codex fork ids, orphaned classify requests (T674)

**Changes:** I7b-1 joins the vec0 shadow table on rowid; its chunk_id column is the storage block, so every vector past block one read as a ghost. Exemplar extraction runs `git show` with piped stderr and `--end-of-options`. The codex adapter takes the session id from the first `session_meta`; forked rollouts replay the parent's after their own and overwrote it. `withTimeout` aborts the work's signal at the deadline and `classify` stops retrying once aborted. `LLMUnreachableError` messages name their cause. Migration 040 adds covering indexes for the dataset session projection and the status integrity checks, and the dataset's stale-alert pass is linear.

**Results:** The embedder "unreachable" failures were the daemon, not the embedder: over 10 minutes every embed answered in under 0.3 s while the daemon's health endpoint stalled for up to 60+ s. Stack samples put the main thread in GET /api/dataset, which read every session body and filtered all sessions per stale entity: 37 to 125 s per UI page load. On a copy of the live database the build now takes 1.9 s plus 0.3 s to serialise 35MB, and the integrity sweep 1 s cold, 87 ms warm. I7b-1 on the live db: 105,352 reported, 4 real. A scheduler timeout used to leave the request running up to 180 s with two retries, matching the bursts of 48 to 157 timeouts.

**State:** Released as 0.21.16 (log faults) and 0.21.17 (dataset stall). `tests/integration/mcp-recall-logging.test.ts` is flaky under full-suite load (passes alone); the Postgres integration tests need a local Postgres. The 64 codex fork files were queued for re-ingest by clearing their adapter_state rows (backup in `~/.nlm/adapter_state-codex-forks-20261013.json`).

**Next:** the dataset build still holds the event loop about 2 s per UI load, enough to time out a concurrent session-start recall (2 s budget); moving it to a worker thread removes that. 4 real I7b-1 orphans have no `doctor --fix` branch.

## 2026-10-13 - Clef ingest gate tuned on stored-output labels (T644)

**Changes:** The gate asks four more Clef questions in the same call (`gateQuestions()`) and combines the answers with session length in a fitted logistic model (`src/core/classifier/gate-model.ts`, generated `gate-model-params.ts`) that predicts whether the classifier would store anything. `NLM_INGEST_GATE_THRESHOLD` is gone: the threshold is fitted with the model. Shadow lines now log P(stored). New `scripts/eval/clef-gate-collect.ts`, `clef-gate-fit.ts` and `lib/logreg.ts`; `clef-shadow.ts` backfills with the production gate.

**Results:** On held-out sessions the fitted gate beats importance < 1.5 everywhere: historical AUC 0.919 vs 0.863 (facts lost 0.2% vs 1.4%), live 0.714 vs 0.683 (0.5% vs 2.2%), audited 0.966 vs 0.933 with no worthwhile session skipped. It skips fewer sessions (live 4.8%).

**State:** Released in 0.21.15, then rejected on cost the same day: the gate takes 2 to 10 s on every session and only skips short ones the classifier handles in 6 to 15 s; break-even needs about 40% skipped against 4.8% live. `NLM_INGEST_GATE=off` on this install. Verdict in `docs/clef-decision-panel-findings.md`.

**Next:** none for the ingest gate. Further Clef candidates are measured on cost against the call they replace before any tuning.

## 2026-10-13 - Clef ingest gate and workstream-binding eval (T642, T640)

**Changes:** The daemon can consult Clef before the classifier: `NLM_INGEST_GATE=off|shadow|live` (default off), `NLM_INGEST_GATE_THRESHOLD` (default 1.5). In live mode a session scoring under the threshold is stored and embedded with its adapter label but no extraction, stamped `clef-gate` provenance, and not bound to a workstream. Clef errors fail open to the classifier. The Clef client and the calibrated triage panel moved from `scripts/eval/lib` to `src/llm/clef-client.ts` and `src/core/classifier/triage-panel.ts`. New `scripts/eval/clef-workstream.ts`.

**Results:** Workstream binding with Clef was not adopted: on the 50-row matcher gold it never beat the production namer (13 of 17 correct, 1 false bind) without adding false binds.

**State:** Gate code landed, off by default. Shadow mode is the next step on this install.

**Next:** a week of shadow data, then a live decision with Edward.

## 2026-10-10 - Clef decision-model evaluation tooling and findings (T533)

**Changes:** `scripts/eval/` gains a fail-open Clef client (`lib/clef-client.ts`), stats and panel helpers, `clef-triage.ts` (an importance gate scored against audited labels), `clef-yield.ts` (the gate's cost against stored decisions and facts) and `clef-shadow.ts` (logs what the gate would do on newly ingested sessions). `docs/clef-decision-panel-findings.md` records the results. No product code changed.

**Results:** An importance score under 1.5 skips 28.5% of sessions on 799 random historical sessions and keeps 99.5% of stored decisions and 97.6% of stored facts; on 63 audited held-out sessions it skipped none of the 43 worthwhile ones.

**State:** Landed on main. Nothing in the daemon calls Clef yet and the shadow logger is not scheduled.

**Next:** a flag-gated, fail-open ingest gate (T615). The judge and session-close experiments in the plan were not run.

## 2026-10-09 - EmbeddingGemma-2 A/B: stay on nomic + CodeRank; corroboration boost flagged (T504)

**Changes:** Evals made embedder-agnostic so any model can be A/B'd in one command. LongMemEval harness embeds through `buildEmbedder` (the daemon's lane) with one cache file per embed model and records the embedder in the report. `fact-recall-eval` uses `buildEmbedder`, gains `--reembed-facts` (rebuilds the sandbox's fact vectors with the arm's model), `--gold=topic,paraphrase` and `--boost-caps=default,1` scored over one set of vectors; its paraphrase question writer now calls the classifier lane (LiteLLM) and fails loud instead of silently falling back to the topic string when raw Ollama was down. New `scripts/eval/code-embed-ab.ts`: code-lane retrieval over the production exemplar corpus (query = session label, relevant = that session's exemplars). The EmbeddingGemma prompt support used for the trial was reverted: nothing uses it.

**Results (embeddinggemma-2-mxfp8 on oMLX vs production lanes):** LongMemEval-S n=500 semantic R@1 87.8% vs nomic 81.0%, R@5 98.6% vs 95.4%; hybrid identical (96.6%) because session hybrid is keyword-primary. Fact recall, 300 live decision facts, both arms re-embedded on one snapshot, boost off: paraphrase semantic R@1 76.3% vs nomic 87.0%, hybrid 70.3% vs 81.3%; topic semantic 69.3% vs 87.7%. Code lane (1554 exemplars): production-format MRR 0.787 (0.797 with the generic search prompt) vs CodeRank 0.853; code-only tie (0.50 vs 0.49). Speed: gemma ~110 ms/chunk serial, 3x faster than CodeRank in bulk; full corpus re-embed ~3h.

**Decisions:** keep nomic (prose) + CodeRank (code). Gemma's session win is mostly in semantic mode (sessions default to keyword) while its fact loss hits hybrid (the fact default), and facts share the prose lane.

**State:** Corroboration boost (`NLM_FACT_CORROBORATION_BOOST_CAP`, default 2.0) costs fact recall heavily for both models: nomic hybrid paraphrase R@1 27% boosted vs 81% at cap 1. The eval targets one specific fact, so it may undervalue corroborated facts; validating against real recall citations is a follow-up task before retuning.

_Older entries archived in CHANGELOG-2026.md_
