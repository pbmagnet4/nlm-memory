# nlm-memory CHANGELOG


## 2026-10-27 - Public next-channel prerelease 0.21.21-rc.1 (T1156)

**Changes:** Published the reviewed property-capable source as an opt-in npm prerelease. Fixed release-channel handling so prereleases publish to next and GitHub prerelease/non-latest, while stable versions retain latest behavior. Added 12 command-level/channel regressions; two safety checks failed against the old workflow. Updated public availability and upgrade/default documentation through PRs #61 and #62. Automatic property inference stays disabled; the managed daemon was not upgraded.

**Results:** Full local suite passed 3,367 tests (three skips), typecheck, build and packed-plugin checks. Independent Muse code/security review returned zero findings; preparation and final publication-doc PR CI passed. Trusted Release run 40573102445 succeeded with provenance. Registry next resolves to 0.21.21-rc.1; npm latest and GitHub latest remain 0.21.20. Downloaded SHA-512 matches registry metadata and gitHead matches tagged public source 3bd0a097cf0315d280bb2a94df8d8d6e58c2ab80. A clean isolated npm install on Node 22.23.1 passed CLI/native SQLite/vector, catalog, correction, property/tenant isolation and disabled-inference checks. One artifact-scan match was verified as a non-secret hostname/port URL in an unchanged public Keycloak fixture.

**State:** Public release: https://github.com/pbmagnet4/nlm-memory/releases/tag/v0.21.21-rc.1. Public documentation merge: 25a39459c4f616694830432c7400b5a5002d8082. Private verification receipt: ~/.nxtos/state/T1156-prerelease.json; artifact/metadata/smoke evidence: ~/.nxtos/state/releases/nlm-memory/0.21.21-rc.1/. Local operational history remains private and product content matches GitHub.


## 2026-10-27 - Public source and GitHub refresh (T1153)

**Changes:** Published a clean product-source snapshot on public ancestry via GitHub PR #60, keeping private deployment plans/changelogs and the corpus sampler out of the public branch. Rewrote the README around recovery, source evidence and corrections; split reference docs; clarified stable/source/experimental capabilities; corrected security/runtime-wiring claims; added an isolated assertion-checked fictional demo and its CI step. Updated repository description/topics and opened roadmap issues #57 ownership, #58 usefulness and #59 historical origins.

**Results:** Local checks passed 3,355 tests (three skips), typecheck, build, packed-plugin verification, the synthetic demo and relative-link checks. Independent Muse review returned zero findings; Gitleaks found zero secrets in the new public history. Final PR CI passed, including PostgreSQL and the demo. Public merge f7602e7c46fa7e97f6588a9a7b20a24abfa8b061; final public head a228115aeea8acee15e023e2a57c71750ce51fd3. GitHub main serves the new README. npm stable remains 0.21.20; the running daemon was not changed.

**State:** Local reconciliation retains the five deliberately private operational files; all published product/runtime content matches GitHub. No private ancestry was pushed. Private receipt: ~/.nxtos/state/T1153-publication.json; independent review: ~/.nxtos/logs/landing-reviews/T1153-public.json. Public roadmap issue #57 is linked to internal T1142.


## 2026-10-27 - Bounded property activation build (T1130)

**Changes:** Separated repository/explicit associations from experimental subject/quote/entity inference. Real source evaluation rejected subject-only ownership, name-bearing quotes about dependencies, and entity references copied from evaluation transcripts. The experimental inference flag defaults off and inference backfill refuses to run unless explicitly enabled. Tightened its quote matching to reject path and identifier fragments.

**State:** Live managed prerelease 0.21.21-property.1, schema 45. Imported 67 canonical properties, six reviewed fact corrections, five explicit session references and one captured-repository reference. Property-aware recall/isolation and repository-origin relevance are enabled; automatic fact ownership, entity-name associations and inference backfill stay disabled (T1142). All four independent review findings were fixed; 3,355 tests and 16 live transport checks pass. Provider configuration is unchanged, normal ingestion resumed, and the pre-attribution DB/config/binary rollback set is verified. Evidence and limits: `docs/plans/2026-10-27-property-activation.md`.

## 2026-10-27 - Canonical memory properties and assertion-context isolation (T1128)

**Changes:** Added a tenant-scoped property catalog, session relevance from exact entities/repository origin (including task worktrees), per-fact attribution before collapse, durable evidence-bound corrections, conservative backfill, and explicit property filters across MCP, HTTP and CLI recall. Fact history, corroboration, context deduplication, embeddings, the write-time judge and session-supersession cascades respect assertion context. Added a read-only coverage tool and shared SQLite/PostgreSQL contracts.

**Results:** A read-only baseline against 67 registry properties found deterministic proposals for 680 of 40,398 active facts and entity references in 8,846 of 24,514 sessions. This measures coverage, not precision. Backend, transport and regression checks are recorded in the task plan.

**State:** Implementation is source-only, with automatic attribution opt-in and broader inference/injection gated. Live memories and the installed runtime were not changed. Public usage and correction semantics are in `docs/properties.md`.

**Next:** Independently label corpus cases and freeze acceptance thresholds before broader inference or automatic property selection. Review a backfill preview before applying it; repair previously incorrect supersession separately.

## 2026-10-21 - Retrieval release published and active as 0.21.20 (T939)

**Changes:** Published the reviewed T803/T806 retrieval work and T937 compact recall through GitHub/npm, then installed the SHA-512-verified 0.21.20 artifact in the managed runtime and restarted the daemon. Fixed a clean-runner test assumption caught by CI (0.21.18 stopped before npm; 0.21.19 passed). A live transcript canary then reproduced a TOON encoder/decoder mismatch for bracketed chat markers; 0.21.20 validates decodability and falls back to JSON under the same response budget. Added full Unicode page-reconstruction coverage. Generated bundle diffs were version-only.

**Results:** Local build/typecheck/packed-plugin contract and 3,290 tests pass (three opt-in skips); final GitHub Release and PostgreSQL-backed CI both pass. Independent public-source reviews found no blocker; low CI-test leads were checked and rejected, formatter review informational only. All 37 live MCP assertions pass, and this conversation's existing connector returns compact hits/cursors. Schema is 43; corpus counts increased normally through activation. Full evidence and measurement limits: `docs/memory-retrieval-results.md`.

**State:** npm latest and the active daemon are 0.21.20. Consistent pre-migration SQLite/config backup verified; original 0.21.17 and compatible 0.21.19 installations preserved for rollback. Provider configuration unchanged. Scientific promotion remains inconclusive as recorded in T806; no optional ranking/model feature was enabled.

**Next:** Routine operation. Existing T810 hydration advisory and T527/T679 remain separate follow-ups.

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

_Older entries archived in CHANGELOG-2026.md_
