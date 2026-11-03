# nlm-memory CHANGELOG

## 2026-11-03 — Honor active Codex home during current-session normalization (T1456)

Fixed pinned current-session lookup for isolated Codex client profiles: use the invoking CODEX_HOME sessions directory for this command while preserving registered daemon sources. Added real fixture discovery, exact-ID refusal, and registered-source fallback tests. The actual MetaZoo session normalizes with exact-session-id selection; no transcript classifier call is needed for verification.

## 2026-11-02 - Classifier gateway fallback: daemon retries Tailscale base, scanner verifies both forwards (T1360, deployed 0.21.21-t1360.1)

**Changes:** `src/llm/deepseek-client.ts` — `DeepSeekClient` accepts `fallbackBaseUrl` and retries classify once against it on network errors and HTTP 5xx (4xx/schema fail fast); `classifier-box.ts` passes it through; `build-classifier.ts` reads `NLM_CLASSIFIER_FALLBACK_URL` (mirrors the session-close scanner's LAN/Tailscale fallback). Session-close `scan.py` (user skill, `~/.agents/skills/session-close`) now accepts both Pro-local oMLX forwards (`:8012`/`:8010`) at route verification instead of `:8012`-only. New tests: `tests/unit/llm/deepseek-client.test.ts` fallback block (5 cases); scanner regression test for mixed deployments. Full unit suite 2197 passed, typecheck clean. Deployed `0.21.21-t1360.1` (DB snapshotted first), `~/.nlm/.env` gained the fallback URL, daemon restarted via `launchctl kickstart -k`. (Shipped on `fix/classifier-gateway-fallback`, landed `0f54f26`; T1360 done.)

**Decisions:** no cloud fallback (session text stays on the private gateway); per-call failover instead of sticky preference (the primary timeout bounds each attempt; the outer retry still applies). Env var, not a code default: stock checkouts keep single-base behavior.

**State:** daemon healthy on the new build; single-fixture live eval 100% schema-valid (~12s); failover smoke (dead primary → real gateway) returned a valid classification.

## 2026-10-28 - Code-lane embedder switchable with rebuild; parked minors fixed (T1179, T1194)

**Changes:** Settings > Embedder now edits the code lane's provider and model. A stale change needs `confirm_reembed`, then starts a supervised `nlm embed-backfill --exemplars` that drops and recreates the code vector table at the probed dim (SQLite vec0, pg `vector(n)` + index), records `embedding_config` right after the drop so an interrupted run resumes, and re-embeds every exemplar. The 24h exemplar sweep skips a stale lane instead of writing mixed-model vectors, and re-resolves the lane identity each tick. T1194: the chunk retry sweep's write is conditional on the pending row and chunk text (a re-ingest during the embed wins); `doctor --fix` prints applied I5b repairs and no longer claims "nothing to repair" after a guard refusal; aider/windsurf/cursor throw on unreadable sources so the next scan retries (ItemTable-less DBs skipped); pg gets the fact-embed retry sweep (pg migration 045) and pg I5a/I5b repair tests. #1142 evaluation design landed (docs/plans/2026-10-28-property-inference-evaluation-design.md).

**Results:** Landing gates passed for 63b1f5a (T1179) and 25d0e16 (T1194); Muse reviews found 1 + 2 real issues, all fixed with tests. Deployed as 0.21.21-t1194.1 (schema 48, deps unchanged); backup ~/.nlm/backups/T1194-2026-10-28T15-54-59Z (quick_check ok). Both lanes reconcile "match"; exemplar `--dry-run` reports no rebuild needed; capture continues after restart.

**State:** Live check of a real code-lane model switch (confirm dialog, job progress) not exercised. #1142 decisions recorded on the task (28-day window, full labelling, Muse re-score); build next.

**Update (T1208):** settings never persist an embedder key (non-null `api_key` → 400; legacy stored keys still resolve and can be cleared). Deployed 0.21.21-t1208.1. The shared LiteLLM key moved to Infisical `/mini/nlm/NLM_LITELLM_API_KEY`; `run.sh` reads it per launch via `vault-key.mjs` on the bundled node (the nxtcli client sits under ~/Documents, which TCC blocks for the launch agent: the first attempt started keyless and 401'd until rolled back), with Keychain item `io.whtnxt.nlm.litellm-key` as launch fallback. Carry `run.sh` + `vault-key.mjs` forward on every deploy. The literal is out of ~/.nlm/.env; older `.env.bak-*` copies still hold it.

**Next:** Infisical move for the embedder/classifier key; #1142 build after the open questions are answered.

## 2026-10-28 - Supersession regression fixed, Codex 0.151 text recovered, chunk embeds atomic (T1187)

**Changes:** NULL-slug facts supersede again (ingest collapse and write-judge); collapse is time-aware, so an older re-ingested fact lands already superseded, and re-ingest re-evaluates `superseded_by`. Doctor I5a groups by tenant + `property_slug`; `doctor --fix` gains I5a, I5b and I7b-1 repairs. Codex `extractTurn` reads the 0.151+ `item_completed` `UserMessage`/`AgentMessage` shapes. New `nlm reingest --adapter <name> [--dry-run] [--limit N]`. Vec + map chunk writes are atomic with a `chunk_embed_pending` queue (sqlite 048 / pg 044) and a 2-minute retry sweep. Also: scan-once stat guard (T1182), drift alert moved into the sequential alert runner (T1183), classifier dropdown fix (T1186), recall gate removed (#616), `usefulnessModel()` replaces the hardcoded qwen, bundles regenerated (#781).

**Results:** Deployed as 0.21.21-t1187.1 (schema 48). `doctor --fix` superseded 98 stale facts in 76 single-valued groups; doctor clean. Codex canary `--limit 20`: 20/20 ingested, +163 facts. Full Codex re-ingest (~993 sessions) running.

**State:** Parked: chunk guard can keep a stale sweep vector over a fresh one; `doctor --fix` doesn't print I5b repairs; PG repair paths untested and PG lacks a fact-embed sweep; aider/windsurf/cursor still record transient read errors as empty; embedder API key stored in plain text.

**Next:** Close #943 when the full re-ingest finishes clean; T1179 code-lane re-embed; #1142 property-inference evaluation.

## 2026-10-27 - Approved session-close captures and agent guide (T1172)

**Changes:** Added the short AGENTS.md router for development, property attribution, release channels and reviewed public ancestry (guide commit 1af338a; local landing 245aeec). Updated existing Backlog task T943 with verified Codex response_item.message coverage evidence rather than creating a duplicate. No normalization fix was made.

**Results:** Three approved wiki syntheses cover ownership evidence and transcript coverage, public Git ancestry, and npm channel/artifact verification. Metadata, dated track records and ingest log entries were verified in vault commit 2b2b420. Guide links and whitespace checks pass; these documentation captures do not change runtime behavior.

**State:** NLM guide landed locally. Vault landing is blocked by inherited overlapping edits: the normal guard refused without moving main or changing those files. Approved captures are committed in ~/.nxtos/worktrees/vault-T1172-close on docs/T1172-approved-close; T1172 remains blocked until safe vault integration. Private evidence: ~/.nxtos/state/session-close/01a17879-d2f8-7791-9b99-90fc8b37feb0/. No public push or release was made by this close.

**Next:** Integrate the retained vault commit after the existing edits are finalized; keep T943 as the separate capture-coverage bug.

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

