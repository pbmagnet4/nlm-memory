# Top-Tier Campaign Roadmap

Successor to the elite-gap roadmap (2026-07-02), which is now substantially executed (Phases 1-3 shipped; Phase 4 instrumented and gated). This document defines "top-tier agent memory system" as five falsifiable claims, sequences the remaining work into six waves, and disposes every open NocoDB row into exactly one of: a wave, an operator lane, parked-with-a-trigger, or closed. Each wave gets its own SDD implementation plan in a fresh session when picked up; this document locks scope, ordering, gates, and the board mapping.

## The scorecard (definition of done for "top tier")

| # | Claim | Current (measured) | Target |
|---|---|---|---|
| 1 | Benchmark: recall quality is published, reproducible, per-tier | LongMemEval-S hybrid R@5 97.2 (frontier labels); classifier tiers measured floor/mid/cloud; nothing assembled publicly | One public benchmark page; LongMemEval numbers beside Zep/mem0/Letta published figures; `nlm eval` reproduces per-tier rows on a stranger's machine |
| 2 | Consumption: agents actually use the memory | MEASURED (U1, 2026-07-03): usefulness@pull 72.4% (n=78, locked judge; facts 88.1%) vs ambient 18.2%/7.9%; pull volume 3.5/day. Quality target already exceeded; the open gap is frequency | Majority of active sessions issue >= 1 pull (the #392 contract wave owns this); usefulness@pull stays >= 60% as frequency rises |
| 3 | Consolidation: memory stays clean as it grows | 463MB, ~800 sessions/wk rising; 13,368 entities all candidate, 53-59% hapax, zero effective merges ever; re-derivation metric exists but gates nothing | Corpus monitor live with thresholds; entity duplicates converging (safe-class zero); re-derivation trend flat; compaction gate armed with baseline data |
| 4 | Distribution: a stranger succeeds in five minutes | Bundled embedder shipped (no Ollama needed); still terminal-only, no classifier on fresh install | Signed .dmg, GUI onboarding, fresh-Mac-to-first-recall <= 5 min without a terminal |
| 5 | Trust: honest numbers, degrade never wedge | Fail-open hooks; honest digest; but one saturated embed lane wedged the daemon HTTP surface for a night (#389) | Embed deadlines + load-shedding on the daemon; chaos check in CI or runbook; negative results keep getting published |

## Waves

Ordering rationale: U1 validates or invalidates the whole consumption thesis and is mostly reading + measurement, so it goes first and its verdict steers everything after. U2 is the biggest quality lever and its plan is already written. U3 is assembly on top of U1/U2 numbers. U4 is packaging, independent enough to overlap U3. U5 contains one hotfix pulled forward. U6 is reach and comes last because parity tests (U5) make new runtimes cheap and safe.

### U1: Consumption (validate the thesis)
The product question: do agents pull, and is what they pull useful? Read the post-pivot window (#366, open since 06-23; verify the operator env actually ran pull-mode before trusting the numbers). Build the pull-path usefulness instrument (reuse the locked judge and the in-process recall pattern from the #357 wave). Iterate the shipped recall contract against measured pull rates. Decide the shipped-user default posture (ambient vs pull-first contract); that decision resolves #347 either way. HOTFIX rider: #389 (daemon embed deadline + hybrid load-shed) ships in this wave because the wedge can recur the moment the corpus reprocess resumes.
**Rows:** #366, #389, #347 (decision kills or keeps it), #285 (unblocks only if the usefulness trend replaces citation precision as the plotted metric).
**Gate:** pull-usefulness number exists on n >= 30; contract change measured against it; default-posture decision recorded; wedge no longer reproducible under a saturated lane.

### U2: Consolidation (retention Stage A+B and the fact layer)
Execute `docs/superpowers/plans/2026-07-03-retention-stage-ab-plan.md` (ready). Then typed facts (#279: decision/preference/constraint/status as first-class fact kinds, supersedence-aware) and the entity typing/promotion sweep (#262 + #273, which need the merge primitive this wave ships). Fix-or-fence decision on the exemplar capture pipeline (#354): either the producer starts writing model/outcome/survived truthfully or the lane is fenced off and its dependents close. #327 (fact candidate cleanup) and #358 (multi-valued predicates) ride along as small tasks.
**Rows:** #353, #279, #262, #273, #354, #327, #358, and #337/#346 live or die with the #354 decision.
**Gate:** retention plan's own gates; typed facts measurable on the gold sets; #354 decision executed, not deferred.

### U3: Benchmark and credibility (assembly)
One public benchmark page: LongMemEval methodology + numbers vs competitors' published figures, the classifier tier table, and the usefulness story including the honest negatives (#357's no-ship is marketing for a system that measures itself). README truth pass (#310). Lock the private corpus bench (#222) and build its harness (#223): the corpus-specific benchmark is the differentiator eval no competitor can copy. Anecdote content (#160) and the side-by-side demo video (#211) are Edward-driven riders.
**Rows:** #310, #222, #223, #160, #211, plus #281 partially (architecture doc section if cheap).
**Gate:** a stranger can reproduce the benchmark page's numbers with `nlm eval` + the harness; README claims all trace to a measurement.

### U4: Distribution (the desktop product)
#363 slices 2-3: Electron shell + signed/notarized .dmg + auto-update, then GUI first-run onboarding (classifier choice: BYOK or index-only). Settings UI provider picker (#368) belongs to onboarding. Install hardening riders: #151 (nvm warning), #314 (naming normalization), #218 (export/import portability). The P2 UI defect list (#158, #193, #197, #198, #232, #233, #234, #261) gets fixed here, where the UI becomes a customer-facing surface, alongside the parked UI-polish umbrella (see board dispositions). #212/#213 (stable pin, shadow upgrade) re-evaluate once auto-update exists.
**Rows:** #363, #368, #151, #314, #218, #158, #193, #197, #198, #232, #233, #234, #261, UI umbrella, #212, #213.
**Gate:** fresh-Mac-to-first-recall <= 5 minutes, no terminal, measured with a stopwatch and written down.

### U5: Trust and parity (reliability hardening)
Runtime parity contract tests (#315), action-layer polish (#294, junior-executable), pg reprocess variant (#388), plus whatever chaos follow-ups U1's #389 fix surfaced. Native hook ingest (#156) stays parked here until scale demands it; jsonl polling works at current volume.
**Rows:** #315, #294, #388, (#156 parked trigger: ingest latency or race complaints).
**Gate:** parity suite green for every hook-bearing runtime; pg and sqlite feature-equivalent on everything shipped above.

### U6: Reach (more runtimes)
Cursor/Windsurf hook research (#287), Hermes session-start recall (#288), gemini/aider adapters (#110). Cheap and safe only after U5's parity tests exist.
**Rows:** #287, #288, #110.
**Gate:** each new runtime lands with its parity contract test, not just a manual demo.

## Parallel track (not wave-sequenced)

- **#348 within-install project scoping:** leak-sensitive, own design-first wave in a fresh session (its notes require it). Prerequisite for client deployment, not for single-user top-tier; schedule on demand.
- **#352 telemetry foundations:** owned by the other controller session, awaiting sign-off; untouched by this campaign.
- **Operator lane (Edward):** #390 relaunch the corpus reprocess (resumable); #385 ralph lane restore (workspace infra, not NLM code); #147 archive-or-delete the old Python repo (five-minute decision); #145 stale content refresh (one-time cleanup).
- **Parked with triggers:** #78 multi-machine sync (trigger: second machine in daily use or 1.0); #276 hooks-install (trigger: U2 typed facts land, then re-design against real primitives); #362 toolbelt (trigger: typed facts prove out); #79-class multi-user remains out of scope per the elite-gap roadmap.

## Board dispositions executed with this roadmap

- The 33 P3 UI-polish rows (#2, #199-#207, #230, #238-#250, #251-#256, #263, #268, #269) fold into ONE umbrella row ("Desktop UI polish batch, execute inside U4") and close individually with pointer notes. They are real but individually un-schedulable; as a batch inside U4 they are one implementer-week.
- #342 (harden-for-client umbrella) closes as superseded: its scope decomposed into #344-#348 and this campaign.
- Every wave's SDD plan must end with a board-sync task: close or re-file its rows with a why. The board's steady state is: every open row belongs to a wave, the parallel track, or has a written trigger.

## Out of scope (unchanged)

Multi-user/hosted deployment; vendor-specific integrations beyond the OpenAI-compatible contract; storage-engine replacement; the temporal knowledge graph, DECIDED 2026-07-03 on the Phase 4 gate data (14 days of intent telemetry, n=640: 99.1% lookup, 0.9% relational, 0% temporal): not built; telemetry stays on and the decision reopens only if relational share becomes non-trivial. Also decided 2026-07-03: fresh installs ship the pull-first posture (see #392), grounded in the U1 measurement (pulls 72.4% useful vs ambient 18.2%/7.9%).
