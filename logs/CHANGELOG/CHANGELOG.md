# nlm-memory CHANGELOG

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

## 2026-10-09 - `nlm transcript current` in source (T525)

**Changes:** session-close's scanner normalizes the live transcript through `nlm transcript current`, but that command only ever existed in a private 0.21.5 tarball installed at `~/.local/share/nlm-session-close`; it was never committed. Any shell that missed that build fell back to the deployed `nlm` and died with `unknown command 'transcript'`. Ported it into source: `src/core/transcript/current-session.ts` (runtime aliases, session-ID env detection, exact-ID-else-newest-in-project resolution) plus the CLI subcommand, which builds adapters from the registered sources. Now covers Muse too. Same JSON envelope (`schemaVersion: 1`, adapter, selection, session). 10 new unit tests; live check resolved this Claude Code session by exact ID (296 turns), plus Muse and Codex newest-in-project.

**Decisions:** reads `CLAUDE_CODE_SESSION_ID` (what Claude Code actually exports) as well as `CLAUDE_SESSION_ID`; the old build only knew the latter, so `--runtime auto` never pinned Claude Code sessions. A session with no projectDir no longer matches an arbitrary cwd (refuse over guess, the scanner's own rule). No per-runtime default-adapter fallback: `seedDefaults` registers every runtime.

**State:** landed on main, not yet released. Once a release with it is installed, session-close's scan.py can drop the dedicated-build lookup and `~/.local/share/nlm-session-close` can go.

## 2026-10-07 - 0.21.11 cut and live on the daemon; release-contract pack bug fixed, 0.21.12 staged

**Changes:** Merged feat/learner-evidence to main (10a88d2..8005e43 landing merge; tree identical to the ff tip) plus chore(release) 0.21.11 (same 6 version files as 0.21.10). Pushed main, tagged v0.21.11. Installed versions/0.21.11 from exact tag content (npm ci, full build, prod prune, copied node 22.23.1, run.sh), flipped current, kickstarted io.whtnxt.nxtos.nlm. /api/health reports 0.21.11 warmup ready; schema_migrations top is 39, so migration 039 applied at boot with no duplicate-skip. Tag CI Release failed at Verify Codex release contract: the script did JSON.parse on `npm pack --dry-run --json` stdout, but npm runs prepare before packing, so vite's build banner lands on the same stream ahead of the JSON (reproduced locally). Fixed with exported packedFiles() (ANSI-strip, parse from the first `[`) plus a 3-case vitest regression; the exact CI step passes locally. Bumped 0.21.12 for the fixed pipeline (commit/tag/push pending in the scratch worktree); a tag checkout is immutable, so v0.21.11 can never go green.

**Decisions:** 0.21.12 over moving the v0.21.11 tag (public repo, tags immutable). Parse-from-first-`[` over --ignore-scripts (npm 10 runs prepare on pack anyway, verified locally; parsing is version-proof). No daemon reinstall for .12: the delta from the live 0.21.11 install is release-script only.

**State:** Daemon live on 0.21.11. npm latest still 0.21.0 until the v0.21.12 tag CI publishes. fix/dataset-sqlite-variable-limit (Edward's staged classifier work) untouched throughout. Release tooling note: the nxtgit session from the 0.21.11 cut was ended, and an ended record still pins the harness session (peek ignores status), so checkout/commit/push all refuse with no new identity obtainable mid-conversation; the .12 line was assembled in a scratch worktree instead.

## 2026-10-06 - Learner evidence shipped (M0–M6): Gnos-style concept tracking across recall, MCP, and UI

**Changes:** new learner-evidence subsystem (spec `docs/superpowers/specs/2026-10-06-learner-evidence-design.md`, SDD-lite with briefs/reports in `docs/superpowers/records/learner-evidence/`). Storage: sqlite `039` + pg `037` (`learners`, `enrollments`, `learning_events`, all STAMP; learner PK is composite `(tenant_id, id)`), `LearnerStore` port with sqlite/pg impls wired into `Storage`, 20-test backend contract both lanes. Core: Gnos evidence-validation + deterministic summary port (exposed/practicing/demonstrated/retained, demotion on failure, never "mastered"), service orchestration. MCP: `learner_enroll/record/summary/complete_course` on both transports. Recall: `relatedConcepts` through RecallService → `/api/recall` (`?withConcepts`, hook-automatic) → hook → `## Learning state` pointer section (fail-open, kill switch `NLM_HOOK_INJECT_CONCEPTS`). UI: `GET /api/learner/by-session/:id` + drawer section. Eval: summary conformance suite, isolation negatives both lanes, real-store end-to-end recall test; precision-gate entry deliberately declined (deterministic rule path, no scored retrieval to regress — see M6 report). All gates green: typecheck, 42 unit + 20/20 contract + hook/http suites, stdio tool smoke, `build:ui`.

**Decisions:** dedicated store over Fact overload (attempts don't fit triples); summaries computed never stored; enrollment binds a workstream id at enroll; no plan-blob table (ref+fingerprint only, mismatch blocks writes); explicit record only, no classifier extraction in v1; cold-start mitigation is read-time unrecorded-session listing (SessionEnd is fail-open/client-side, wrong surface); drawer text rows over chips (design system forbids new badge families); standalone Learning page deferred.

**State:** merged with origin/main through 0.21.10 (cross-runtime citations, Muse/OpenCode capture, reconcile-facts); learner migrations renumbered sqlite 039 + pg 037 — main's covering-index sqlite 037 and sources-muse sqlite 038 / pg 036 landed while the branch was in flight, and the migrator keys on version number so duplicates would silently skip. Daemon/UI-bundle deploy pending release cut.

## 2026-09-29 (session 2) - Remote Hermes capture, reconcile-facts, cross-runtime citations; 0.21.9-0.21.10 live

**Changes:** hermes-agent had OpenCode's defect (discover() returned bare ids, scanOnce's stat skipped every one), so it had never ingested. It now keys `<db>::<id>` and supplies `stat()` (last message time as mtime, message count as the change marker), and skips machine-driven sessions via `parse_config.excludeSources` (default `cron`). New `nlm reconcile-facts --authorities <file>`: dry run by default, retires (never replaces) live facts that contradict an operator authorities file or name a deleted file; `--apply` backs up first and logs to the supersedence log. Host comparison uses the URL parser only and never flags a value it can't parse. The conversation resolver behind `cite_session` and recall-pull attribution scanned only Claude Code transcripts; it now covers Codex, pi and Muse, which resolve to `<runtime>:<id>`.

**Decisions:** Remote Hermes reaches the store as per-profile SQLite snapshots (online backup API, read-only on the source) synced to the local machine every 15 minutes, one hermes-agent source per profile, rather than a second capture daemon. reconcile-facts retires rather than supersedes: the structured file is the current value, the fact store is history. First real authorities run is ports only; host/url prose is too ambiguous to judge deterministically.

**State:** 0.21.10 installed. 30 hermes-agent sources registered with `excludeSources` covering cron, agent-protocol, tool, one-shot and benchmark runs. reconcile-facts dry run against a snapshot found 6 stale facts; not applied. Suite 2648 passing, only the Postgres-only cycle-guard failures.

**Next:** Confirm hermes-agent rows land once the Muse backlog drains (adapters scan in source order). Review and apply the reconcile-facts findings. cursor still has the bare-id discover() shape.

## 2026-09-29 - Cross-agent capture: Muse and OpenCode adapters made shippable, 0.21.7 staged

**Changes:** Merged the Muse adapter (feat/muse-adapter, previously unmerged) and fixed a boot crash it would have caused: the `sources.kind` CHECK didn't allow `muse`, so `seedDefaults()` fails on any machine with a Muse sessions dir. Migration 038 (SQLite rebuild) + pg 036 (ALTER). OpenCode's adapter looked for `opencode.db` under Application Support on macOS; OpenCode uses the XDG data path there too, so it now prefers XDG and falls back. SessionStart recall now builds its query from the directory name plus branch and the last 3 commit subjects: a one-word directory name alone is rejected by `extractRecallQuery`, which skipped 117 of 268 SessionStart recalls in the week of 09-22. Version bumped to 0.21.7 and bundles regenerated. Sandbox boot against a copy of the live store then turned up two more: `nlm connect opencode` claimed the source was "already registered (see migration 010)" but 010 never inserted a row, so OpenCode was never scanned; it now registers the source, `nlm connect muse` does the same, and `/api/sources` accepts every adapter kind instead of six. And 1,710 of Muse's 1,868 session files are subagent runs, which were landing as standalone sessions; they now use the `<parent>/agent-<id>` shape and get linked to their parent. After installing 0.21.7 live, OpenCode still ingested nothing: `scanOnce` statSync'd every discovered source, and OpenCode's discover() returns session ids, so each one was silently skipped. The adapter had never ingested a row. Adapters can now supply `stat()` for non-file sources; OpenCode keys sources `<db>::<id>` end to end. Shipped as 0.21.8, installed and live 2026-09-29, OpenCode rows landing. hermes-agent and cursor have the same shape and still need `stat()`.

**Decisions:** Released from main rather than release/0.21.6: main already carries the 0.21.6 line (replayed 08-25), and `src/` differs from it by additions only, so merging the release branch in would only re-conflict on generated bundles and the version bump. Hermes adapter left alone: the Pro's real transcripts are per-profile `state.db` files the hermes-agent adapter already reads, so the gap is transport, not parsing.

**State:** Audit corrections: the Claude Code "stall" was not a stall (low Claude Code use 09-28, work moved to Muse); citation-log's last line is 09-29, not 09-10, and the cite attribution fix already shipped in 0.21.6. The daemon logs nowhere since the 09-27 reinstall because the nxtos-written plist sets no StandardOutPath. The Pro's own NLM service (crash-looping since 09-09) was stopped and disabled. Suite: typecheck clean, non-pg suite passing apart from environment-only failures (no built UI in a fresh worktree, no Postgres).

**Next:** Install 0.21.7, back up the store, restart, register Muse and OpenCode sources, ingest a 5-session sample, then backfill. Pro Hermes transport, daemon log path (nxtos), fact reconciliation job, Gemini adapter.
