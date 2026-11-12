# T1783 — recall hubs: memories injected into everything

Measured 2026-11-12 (window: hook-log entries since 2026-10-15). Read-only pass over
`~/.nlm/hook-log.jsonl` and `state/t1782/eval-set.jsonl` (228 judge-labelled
prompt×memory pairs, 0–3, from the same traffic). Parts 2–3 (shipped mechanism + replay
verdict) appended below; source changes ride with the Part 3 commit.

## What the log says

Hook records = lines without `kind`; injections = ids in those lines' `wouldInject`.

| cohort | fires | injections | distinct ids | top-10 share |
|---|---|---|---|---|
| all hook fires | 2 248 | 2 641 | 597 | **32.9 %** |
| e2e fixture traffic only | 549 | 1 176 | — (fixture corpora) | — |
| **real traffic** (fixture-prompt fires dropped) | **1 699** | **1 465** | 569 | **18.4 %** (270/1 465; top-20: 26.9 %) |

The e2e fixture fires (`promptPreview` matching `nxtos-e2e|fixture`) re-inject their own
fixture sessions against a shadow corpus; they are excluded below, but note they alone
push the raw top-10 share to 32.9 %.

Top 20 injected memories, real traffic (score = median final `matchScore` logged for that
id; eval columns = this id's pairs in the T1782 eval-set, mean relevance 0–3):

| # | id | memory | inj | distinct prompts | distinct convs | med score | eval pairs | mean label |
|---|---|---|---|---|---|---|---|---|
| 1 | `codex_01a17dc9…aa543` | Fixing miner trace scan date window | 50 | 1 | 28 | 0.92 | 9 | 3.00 |
| 2 | `cc_sub_adfb64fa8268b0ed3` | Fix nxtgit land --done logic | 49 | 1 | 27 | 0.99 | 6 | 1.00 |
| 3 | `cc_sub_affa1101acb68efae` | Retire LM Studio and Laguna models | 36 | 1 | 14 | 0.95 | 4 | 0.00 |
| 4 | `cc_4b795dbc…4ff0` | MSM3 scheduler cutover Phase 0 | 24 | 6 | 24 | 0.95 | 3 | 1.00 |
| 5 | `cc_64bcc185…1c8b9` | Fix nxtgit session pinning & secret scan gate | 21 | 6 | 20 | 0.96 | 7 | **0.43** |
| 6 | `muse_01a160bf…df0c` | Defect review for Task T817 | 21 | 6 | 20 | 0.91 | 4 | **0.00** |
| 7 | `cc_d67f180b…1cead8` | NLM classifier fix and tunnel setup | 19 | 5 | 19 | 0.97 | 4 | **0.00** |
| 8 | `cc_0f4a94e4…35df` | BKV Energy ChatGPT plugin kickoff prep | 18 | 1 | 9 | 0.89 | 2 | 0.00 |
| 9 | `muse_01a1a767…c120` | RGR interview deck prep | 17 | 1 | 9 | 1.03 | 2 | 2.00 |
| 10 | `cc_sub_a6b56986a85cfa16d` | Mac Pro landing-gate follow-ups | 15 | 1 | 15 | 0.77 | 3 | 1.00 |
| 11 | `cc_b7192f62…76da` | Code word recall check | 14 | 7 | 14 | 8.04 | 1 | 0.00 |
| 12 | `muse_01a0e421…42e6` | NxtEvals design and SDD initiation | 14 | 2 | 13 | 0.89 | 3 | 1.33 |
| 13 | `muse_01a0e421…/agent-…` | NxtEvals P1 branch verification | 13 | 1 | 12 | 0.89 | 1 | 3.00 |
| 14 | `cc_sub_ab2e0206097d5689d` | (not in eval-set) | 13 | 2 | 13 | 0.90 | 0 | — |
| 15 | `cc_904aaaa2…ea37` | nxtgit porting and cleanup | 12 | 2 | 11 | 0.99 | 4 | 1.25 |
| 16 | `cc_b0604ef0…136cd` | NxtSEO fleet health and sitemap fixes | 12 | 1 | 12 | 0.97 | 3 | 1.00 |
| 17 | `cc_dbae563a…b077` | (not in eval-set — live corpus twin of a fixture id) | 12 | 1 | 12 | 0.85 | 0 | — |
| 18 | `cc_50e7ddb9…e075` | (not in eval-set) | 12 | 1 | 12 | 0.84 | 0 | — |
| 19 | `cc_sub_aa8b7fc94209521b0` | (not in eval-set) | 11 | 1 | 10 | 0.99 | 0 | — |
| 20 | `cc_sub_aee5fdc0700800764` | Git repository topology and merge simulation | 11 | 3 | 9 | 0.98 | 1 | 1.00 |

The hubs named from the T1782 report:

| memory | injections | distinct prompts | eval pairs | mean label |
|---|---|---|---|---|
| Fix nxtgit session pinning + secret scan gate | 21 | 6 | 7 | 0.43 |
| NLM classifier fix and tunnel setup | 19 | 5 | 4 | 0.00 |
| Implement Plan J: onboarding sources and seeding | 7 | 1 | 1 | 0.00 |
| LinkedIn Easy Apply for Ryan Sr Manager | 2 | 2 | 1 | 0.00 |

Two distinct pathologies sit in this table:

1. **Repeat-fire hubs** (ranks 1–3, 8–10): one prompt — a recurring merge/notification
   automation — fires 14–28 times in the window, each time under a *fresh* conversation
   id, and the hook re-injects the same sessions every fire. Per-conversation dedup
   never sees the previous fire. Mean label here ranges from 3.00 (rank 1 actually
   relevant to the automation prompt) to 0.00 (rank 3, `Retire LM Studio and Laguna
   models`, injected 36× with zero relevance).
2. **Cross-topic hubs** (ranks 4–7, 11): sessions like `nxtgit session pinning`, `NLM
   classifier fix`, `Defect review T817` injected across 5–7 genuinely different prompts
   with mean label 0.00–0.43. These consume the three per-fire slots for dozens of
   prompts they have nothing to do with.

Median injection score for nearly every hub is ~0.9 on a 0.89–1.0 plateau: they are not
winning decisively, they are winning the tie across a large flat score region.

## Why these rank high (code path)

The hook path is **pure lexical BM25**, then frequency-blind selection:

- `src/hook/recall-over-http.ts:84` — `recallOverHttp(..., mode = "keyword")`; the prompt
  hook never passes `hybrid`, so there is no semantic leg and no RRF banding on this
  path (logged scores > 1, e.g. 8.04 and 143.7, confirm raw BM25 — hybrid would cap at 1).
- `/api/recall` (`src/http/app.ts:851`) → `RecallService.search`
  (`src/core/recall/recall-service.ts`) → `SqliteSessionStore.keywordSearch`
  (`src/core/storage/sqlite-session-store.ts:962`):
  `-bm25(sessions_fts, 10.0, 4.0, 1.0)` over `label/summary/body`, where the query is
  rebuilt as a quoted-OR of all query tokens (`toMatchExpression`). **Any single shared
  token makes a session a candidate.** Long dev-session transcripts (`body`, weight 1.0
  but huge tf) accumulate contributions from many low-idf tokens — `merge`, `fix`,
  `main`, `landing`, `master`, `session`, `branch` — the exact vocabulary of the
  recurring merge-automation prompts. Sum over ~20 generic OR'd tokens lands every such
  session on the same ~0.9–1.0 plateau; nothing discriminates *within* the plateau.
  The task's "generic summaries near many query embeddings" intuition maps here to
  "generic summaries/ bodies near many query **token-sets**": same hubness, lexical form.
- `finalize()` (`src/core/recall/recall-service.ts:490–525`) multiplies by
  `recencyMultiplier` (half-life 180d, floor 0.25 — `src/core/recall/recency.ts`) and the
  `tiebreakFactor` (`src/core/recall/metadata-tiebreaker.ts`, up to +15 % for decision /
  entity-token overlap, which generic git prompts share with every git session). The
  hub sessions are all *recent* (multiplier ≈ 0.95–1.0), so recency keeps the plateau's
  newest occupants — which are always the same large-repo work sessions — on top.
- Step 5 of `search()` deliberately **removed** citation-frequency reranking
  (`recall-service.ts:280–292`): "a globally-popular session displaces the genuinely-best
  per-query match." Nothing else on this path penalizes *recent over-injection*, so after
  frequency blindness was removed from the daemon, no component owns hub suppression at
  all.
- `selectHits` (`src/core/hook/select.ts:39–52`) then applies:
  - `scoreThreshold` — **default 0** (`parseScoreFloor`), so every BM25 > 0 hit passes;
  - `relativeFloor` 0.9 × median — a *within-fire* trim: when the whole fire is plateau
    hits all scoring ~0.9, the median is 0.9 and the hubs survive by definition; the
    relative floor cannot suppress an off-topic fire (its docstring says so);
  - the memo (`src/core/hook/memo.ts`) dedups **per conversation id only** — repeat
    automation fires get a fresh id each run, so rank-1–3's 50/49/36 injections happen
    despite it;
  - `PER_FIRE_CAP = 3` then takes the first three, which on merge-cadence tokens are the
    same hub trio every time.

Net: a small set of lexically-generic, token-rich, recent sessions forms a permanent
BM25 plateau ceiling; every prompt whose vocabulary overlaps that plateau re-injects the
same trio, and neither the per-fire relative floor nor the per-conversation memo can
break the cycle. Nothing scores "this memory has been injected 40 times in two weeks" —
which is exactly the missing signal Part 2 adds.

## Part 2 — shipped mechanism

`src/core/hook/hubness.ts`, wired in `runHook` (`src/hook/prompt-recall-hook.ts`) between
the recall fetch and `selectHits`, gated by `NLM_HOOK_HUB_DAMP` (shipped **default ON**,
see Part 3):

- **Hubness penalty** — `score / (1 + alpha * ln(1 + spread))` with `alpha = 0.5`
  (`NLM_HOOK_HUB_ALPHA`) and `spread` = distinct prompt previews the id was injected into
  over the last 14 days (`HUB_WINDOW_DAYS`). Spread comes from `countRecentInjectionPrompts`
  (`src/core/recall/hook-recall-log.ts`), a synchronous tail-capped scan of the hook's own
  `wouldInject` records — no new store, no daemon round-trip; the 4 MB cap can only
  under-count, which only weakens the penalty. The penalty **arms at spread 2**
  (`HUB_MIN_PROMPTS`): a session re-surfaced forty times into one recurring automation
  prompt has spread 1 and is untouched — that repetition is legitimate recall, and the
  Part 3 replay showed penalizing it is what would have cost relevant injections.
- **Lexical overlap guard** — a hit below `NLM_HOOK_LEX_FLOOR` (raw BM25 scale) whose
  label+summary share ZERO non-stopword content terms with the prompt is dropped
  (stopwords = the `query-extract` list, now shared). Shipped **disabled by default**
  (`DEFAULT_LEX_FLOOR = 0`): it measured *exactly* inert across all 110 replayed prompts
  (guard-arm rows are row-identical to base below) — a same-domain corpus shares some
  content term with almost every prompt — so it stays as an opt-in safety net, unit-tested.

Both steps are fail-open and monotone-safe: bad env collapses to defaults, a missing
counts file disables the penalty, and the guard never fires on content-word-free prompts.
Tests: `tests/unit/hook/hubness.test.ts`, `tests/unit/recall/hook-recall-count.test.ts`,
five `runHook` cases appended to `tests/integration/prompt-recall-hook.test.ts`.

## Part 3 — offline replay and the default-ON decision

Harness: `scripts/eval/t1783-hub-replay.ts`. The **real production chain**
(`extractRecallQuery -> RecallService mode=keyword -> selectHits`, plus `applyHubness` for
armed arms) runs in-process against a **copy** of `canonical.sqlite` (`.eval/`, disposable)
— never the live daemon. All 110 distinct eval-set prompts. Penalty counts are causal per
fire: hook-log injections in [t − 14 d, t), fixture fires excluded. Candidates that
started *after* the fire are dropped (`bornFilter`) — since October the corpus grew and a
november session could not have been injected in an october fire; without this the
baseline reproduces only 29 % of the original injections and drift, not the fix, decides
the top-3. With it: 41 %. Candidate pool widened to 20 (vs the live 5) purely for labeled
statistical power; the selection chain (caps, floors) is unchanged.

Precision@≤3 counts only replayed injections that carry an eval label (relevant = ≥2);
`relKeep` = relevant injections kept vs the relevant pairs the original fires actually
injected (80). Hub columns: fires where a named hub (session-pinning, classifier-fix,
Plan J, LinkedIn) / a measured top-10 hub enters the injected set, and total hub
injections.

| arm | micro P@≤3 | macro P@≤3 | inj | labeled | rel | relKeep | named-hub fires | top-10 hub fires | hub inj |
|---|---|---|---|---|---|---|---|---|---|
| base | 46.6 % | 46.4 % | 288 | 73 | 34 | 42.5 % | 4 | 7 | 8 |
| penalty, raw counts, α=0.5 | 50.9 % | 48.1 % | 288 | 55 | 28 (−17.6 %) | 35.0 % | 2 | 6 | 6 |
| penalty, raw counts, α=0.3 | 51.8 % | 49.2 % | 288 | 56 | 29 (−14.7 %) | 36.3 % | 2 | 6 | 6 |
| penalty, distinct prompts¹, α=0.5 | 52.6 % | 50.4 % | 288 | 57 | 30 (−11.8 %) | 37.5 % | 2 | 6 | 6 |
| penalty, distinct prompts¹, α=0.2 | 50.8 % | 48.3 % | 289 | 61 | 31 (−8.8 %) | 38.8 % | 2 | 6 | 6 |
| guard only (floor 2.0) | 46.6 % | 46.4 % | 288 | 73 | 34 | 42.5 % | 4 | 7 | 8 |
| **shipped: distinct + arm-at-2, α=0.5** | **47.8 %** | **47.5 %** | 288 | 69 | **33 (−2.9 %)** | 41.3 % | **2** | **5** | **6** |
| shipped config at α=0.3 | 47.1 % | 46.5 % | 288 | 68 | 32 (−5.9 %) | 40.0 % | 2 | 5 | 6 |

¹ without the arm-at-2 exemption (every repeat counted).

Readings:

- Raw-count penalties buy precision (+2.6…+5.2 pp) by cutting **15–18 %** of relevant
  injections — they punish the repeat-automation fires where re-injection was often the
  *right* answer (rank-1 hub's mean label was 3.00). That variant fails the guardrail.
- Hubness is cross-prompt breadth, not frequency: switching to distinct-prompt counts and
  arming at spread ≥ 2 keeps the named-hub suppression halved (4 → 2 fires, top-10 hub
  injections 8 → 6) while relevant falls from 34 to 33 (−2.9 %), inside the 5 % guardrail.
  Precision improves +1.2 pp micro / +1.1 pp macro. (Pre-exemption distinct rows above
  show what the exemption rescued: same hub suppression, 2–4 more relevant kept.)
- The lexical guard removed **zero** hits across all 110 prompts at floor 2.0 — kept as
  tested, opt-in, default off.

**Decision — default ON** (`NLM_HOOK_HUB_DAMP` default true, α=0.5, guard floor 0): meets
both pre-registered conditions (precision up, relevant −2.9 % ≤ 5 %) on 110 prompts /
69 labeled replayed injections. Sample size keeps the margin thin — treat the hub columns
(halved named-hub fires), not the 1.2 pp, as the load-bearing win; re-run the harness
after the corpus accumulates live damped traffic.

Caveats: BM25 scores recompute against the drifted November corpus (summaries
regenerated, idf shifted), so base-arm overlap with the original injections is 41 %, and
some of the 12 unlabeled-at-base injections the fix promotes are simply sessions the
eval never judged; `startedAt <= fire-time` filtering mitigates but cannot fully undo
corpus drift. Replay is hook-path only (`mode=keyword`), matching production.

Repro: `npx tsx scripts/eval/t1783-hub-replay.ts --db=.eval/canonical.sqlite --recall=20
--hubness=distinct --alpha=0.5 --json=out.json` (DB copy: `cp ~/.nlm/canonical.sqlite*`;
the harness opens the copy read-write for idempotent migrations and never the live file).
