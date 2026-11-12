# T1778 — does clef-flash earn a place in NLM? (evaluation only)

Question: `clef-flash-oQ8e` answers the same typed `systemone` panel as the 27B
`clef-oQ4e` in a fraction of the time (0.36 s warm is the quoted figure). Four
NLM decisions currently buy an LLM call: the ingest gate (E1), the recall
relevance check (E2), the populate precision gate (E3) and the dream
contradiction judge (E4). Each was re-measured per model. Nothing in `src/` was
changed; the direct-oMLX client and every threshold live in `scripts/eval/`.

Scripts (all read-only over the caches, all resumable):

| Script | What it does |
| --- | --- |
| `scripts/eval/lib/t1778-clef.ts` | direct `POST {base}/v1/systemone` with a per-call model (the shipped `askClef` pins the gateway path and the 27B model), warm-up, percentile, bounded-concurrency helpers |
| `scripts/eval/lib/t1778-panels.ts` | the production gate panel plus two rephrasings of its two score questions (same answer names, so `gate-model.ts` reads any of them) |
| `scripts/eval/lib/t1778-questions.ts` | E2/E3/E4 question sets, 3 / 3 / 3 phrasings |
| `scripts/eval/t1778-e1-extract.ts` → `-collect.ts` → `-fit.ts` | bodies behind the cached panel → panel answers per model → per-model logistic fit and held-out read |
| `scripts/eval/t1778-e2-recall.ts` | one call per prompt, one score question per candidate memory |
| `scripts/eval/t1778-e3-populate.ts` | one call per page, one score question per drafted statement |
| `scripts/eval/t1778-e4-dream.ts` | the T1609 contradiction proposals against the human labels |
| `scripts/eval/t1778-bench.ts` | serial latency of every payload shape, with the machine load printed beside each number |

Reproduce: `npx tsx scripts/eval/t1778-e1-extract.ts && npx tsx scripts/eval/t1778-e1-collect.ts --model=clef-flash-oQ8e`, then `--report=go` / `-fit.ts`.
Caches went to the git-ignored `.eval/` (byte-identical copies of the `~/.nlm` gold files, verified by sha1 before use); they are deleted after this commit, so the commands above regenerate them.

## Headline

**clef-flash ranks as well as the 27B, and it is about 3.4× cheaper per call —
and that still does not clear the bar, because the gate's cost is paid on every
session and the gate only fires on the short ones.** Verdicts: ingest **no /
shadow only**, recall hook **no (budget)**, populate **not measured**, dream
judge **no (and not yet measurable)**. Details below, with what is *not*
established stated next to what is.

## Latency: the number this evaluation turns on, and how badly the host co-operated

Measured serially, after warming, per payload. `min` is the best of 3–4 reps in
that window; `load` is the 1/5/15-minute load average at the time. The same
240-token call measured **0.25 s in one window and 18.8 s in another** — MSM3's
oMLX also serves the daemon's classifier and embedder lanes, and during this
evaluation a second session was running the same benchmark against it
(`docs/clef-decision-panel-findings.md` already records the same trap: "the
fastest call was 1.05 s, but the median in this run was 6.4 s").

| Payload (clef-flash-oQ8e) | window 1 min/p50 | window 2 min/p50 | load |
| --- | --- | --- | --- |
| gate panel, short session (1.1k tok, 10 q) | 0.997 / 1.02 s | 1.78 / 1.84 s | 7–14 |
| gate panel, 15k session (5.1–5.6k tok, 10 q) | 4.87 / up to 32.8 s | 5.59–9.30 s | 7–14 |
| recall hook, 1 item (376 tok) | 0.377 / 3.64 s | 13.4 / 21.8 s | 7–14 |
| recall hook, 5 items (1.6k tok) | 1.398 / 1.40 s | 21.9 / 22.9 s | 7–14 |
| recall hook, 10 items (3.1k tok) | 2.72 / 2.72 s | 21.8 / 24.6 s | 7–14 |
| populate page, 3 statements (559 tok) | 0.510 / 0.51 s | 15.4 / 18.7 s | 7–14 |
| dream pair (240 tok) | 0.246 / 0.247 s | 16.3 / 18.8 s | 7–14 |

clef-oQ4e, same payloads, window 1: gate panel on a 15k session p50 **15.9–19.4 s**,
gate panel short **3.43–3.52 s**, hook 1 item **1.20 s**.

What is trustworthy:

- **The ratio, 3.2–3.4×**, is stable across windows and payloads (short panel
  1.00 vs 3.43 s; 1-item hook 0.38 vs 1.20 s; 15k panel 4.9 vs 15.9 s). The
  absolute values are not, so nothing here should be quoted as "flash costs X ms".
- **Cost is state-size bound, not question-count bound.** Ten questions over a
  one-line state cost the same as ten over a short session (≈1.0 s); the same
  ten over a 15k-char session cost 4.9–9.3 s. Adding questions is close to free
  (the findings doc's batching result holds); adding transcript is not.
- **The 5-and-10-item hook numbers were tight across reps** (1.40 s and 2.72 s),
  so the hook budget verdict below does not depend on the noisy windows.
- A clean figure needs a window with the daemon's classifier idle. The bench
  prints `load` on every line for exactly that reason — re-run
  `t1778-bench.ts` at 04:00 and take those numbers for any cost arithmetic.

## E1 — ingest gate (`clef-oQ4e` vs `clef-flash-oQ8e`)

Same 1,220 sessions, same `capState`, same `gateQuestions()` panel; the 27B
answers are the cached production panel, the flash answers are re-collected here.
The collection was cut short at tool-call 57, so **only 375 of 1,220 sessions
have flash answers**, and because the collector was ordered tune-first, those
375 are almost all T644 *tune* rows. Rather than report flash on its own tune
rows, **both models were refitted on a fresh id-hash split of the 375 shared
sessions** (`evalSplit` in `t1778-e1-fit.ts`): 167 fit rows (both models, never
reported on) and 208 eval rows (never fitted on). This split is *not* the
T644 split — it is a new one, fixed by hash, disclosed here.

Sanity check that the 375-row subsample is representative: the 27B refit on it
reproduces the published full-sample numbers closely (yield AUC 0.926 vs 0.919
published; live 0.708 vs 0.714; audited 0.947 vs 0.966).

Rule, unchanged from T644: L2 logistic on the 17 `gateFeatures`, threshold the
highest one losing ≤0.5 % of tune decisions and ≤2.5 % of tune facts. Fitted
thresholds differ per model by construction: **0.271 (27B) vs 0.378 (flash)**,
and the weights differ enough that the parameters are not transferable.

| Held-out set | Model | AUC | skipped | decisions lost | facts lost |
| --- | --- | --- | --- | --- | --- |
| yield eval (101 sessions, 268 decisions / 442 facts) | 27B fitted | **0.926** | 20.8 % | 0 (0.0 %) | 2 (0.5 %) |
| | flash fitted | **0.906** | 25.7 % | 2 (0.7 %) | 6 (1.4 %) |
| | 27B `importance < 1.5` | 0.894 | 28.7 % | 1 (0.4 %) | 9 (2.0 %) |
| | flash `importance < 1.5` | 0.881 | 31.7 % | 2 (0.7 %) | 16 (3.6 %) |
| | free rule `chars < 500` | 0.822 | 9.9 % | 1 (0.4 %) | 1 (0.2 %) |
| live eval (26 sessions, 10 / 31) | 27B fitted | 0.708 | 15.4 % | 0 | 2 (6.5 %) |
| | flash fitted | 0.643 | 19.2 % | 0 | 3 (9.7 %) |
| | free rule `chars < 500` | 0.458 | 0.0 % | 0 | 0 |
| audited (82 sessions, 936 / 1106; 60 worthwhile) | 27B fitted | 0.947 | 8.5 % | 0 | 3 (0.3 %) |
| | flash fitted | **0.962** | 9.8 % | 0 | 4 (0.4 %) |
| | 27B `importance < 1.5` | 0.925 | 11.0 % | 2 (0.2 %) | 12 (1.1 %) |
| | flash `importance < 1.5` | 0.868 | 15.9 % | **29 (3.1 %)** | 49 (4.4 %) |
| | free rule `chars < 500` | 0.887 | 1.2 % | 0 | 0 |

Two results matter more than the headline AUCs:

1. **The fitted model transfers; the raw score and the threshold do not.** On the
   audited set, flash's own `importance` score is clearly worse than the 27B's
   (0.868 vs 0.925), and applying the T644 frozen threshold `1.5` to it throws
   away **29 of 936 stored decisions (3.1 %)** where the same rule on the 27B
   loses 2. Refit on flash answers and it is the best model in the table (0.962).
   Swapping the model inside `makeClefIngestGate` without regenerating
   `gate-model-params.ts` would silently be a regression of that size.
2. **Flash does not buy the skip rate the gate needed.** n=26 live sessions is
   far too few to hang anything on, but its AUC (0.64) and its 9.7 % fact loss
   point the same way as the published live-holdout result: recent traffic is
   long agentic work where almost everything yields a fact, and the free
   `chars < 500` rule skips exactly nothing there.

Cost arithmetic, using the *ratio* rather than the absolute numbers, and the
per-session classifier times in `docs/clef-decision-panel-findings.md`
(6–15 s on short sessions, 30–70 s on long ones): the gate is paid on every
session, ≈1 s when the session is short and ≈3.4× that when it is capped at
15k, while the saving is only collected on the ~20–26 % it skips, which are the
short ones (~10 s each). At 25 % skipped that is ≈2.5 s saved against ≈3–4 s
spent per session on a real long-heavy mix. **Flash moves the gate from clearly
negative to roughly break-even; it does not make it positive.** The structural
lever is the bench's other finding — shrink the state, not the model: a 3k-char
state instead of 15k would take the every-session cost from ≈3.4× to ≈1.4× the
short-session cost, which is a bigger win than the model swap and needs no new
model at all.

**Recommendation: no. Keep `NLM_INGEST_GATE=off`; if more skip telemetry is
wanted, `shadow`, never `live`.** Evidence: quality parity is real (0.906/0.962),
the loss ceiling moved against it (0.7 % of decisions on the yield split, above
the 0.5 % the rule allows), and cost is still not net-positive on a long-heavy
mix. Integration point *if* this is ever revisited: `src/core/classifier/ingest-gate.ts:makeClefIngestGate`
already takes the model in its options and `askClef` already takes `model`, so
the change is `model: "clef-flash-oQ8e"` plus a regenerated
`src/core/classifier/gate-model-params.ts` from `scripts/eval/clef-gate-fit.ts --write`
fitted on flash answers — the fitted params are model-specific and must move
together. A capState variant would be a second, separate change (it invalidates
the panel, per the warning at the top of `triage-panel.ts`).

Not run: the two rephrasings of the score questions (`B_anchored`,
`C_counterfactual`) — the endpoint budget went to the flash panel instead. The
phrasing machinery is in `scripts/eval/lib/t1778-panels.ts` and
`t1778-e1-collect.ts --panel=B_anchored --split=tune` runs it; variant selection
must stay on the fit half.

## E2 — recall relevance gate: **no (budget), accuracy unmeasured**

Protocol, ready to run: one call per prompt (`{prompt}` as the shared state),
one `score` question per injected memory, 4 ordered levels, three phrasings
(`R1_generic` = "how relevant is this memory to the user's prompt", the question
this task specified; `R2_productLine` = the wording already in
`scripts/eval/lib/clef-panels.ts`; `R3_lossIfDropped` = the counterfactual).
Split is a fixed hash of the **prompt**, so a prompt's items never straddle
tune/holdout; threshold chosen on tune at 90 % positive retention, read on
holdout. Labels: `~/.nlm/eval/gold-usefulness.jsonl`, 77 rows / 74 prompts,
positive = `used`|`partial` (24) vs `unused` (53).

**No AUC was collected** — every window was too contended for 74 calls to
finish inside the run, and per-call latency in that state ran 3–22 s. Reporting
an AUC is deferred, not downgraded.

The latency verdict does not need the labels, and it is fatal on its own: the
hook budget is 1000 ms total, and flash's tightest measured hook payloads are
**1.40 s at 5 items and 2.72 s at 10 items**. Clef does not fit the hook even on
the fast model, even before contention. `recallGateQuestions` in
`scripts/eval/lib/clef-panels.ts` should stay dead code; H1's demotion stands.
(The label caveat also applies: gold-usefulness marks whether the response *used*
the context, not whether it was on topic, so any AUC on it is a floor — see
`Operations/Tool Lessons/nlm-memory.md`, "NLM eval numbers that mislead".)

## E3 — populate precision gate: **not measured**

`scripts/eval/t1778-e3-populate.ts` implements the experiment and nothing else:
one call per page, one `score` question per statement, three phrasings
(`P1_informative` is the wording this task specified), split by a fixed hash of
the **subject** (86 subjects), threshold = the highest one keeping ≥90 % of the
*fit*-split CORRECT, then precision on holdout, alongside a free rule ("a bare
token or a hash" ) because a free rule is the bar any gate must beat. Data ready:
100 base rows (58 CORRECT / 42 WRONG; WRONG = content_free 31, other_property 5,
wrong_sense 4, self_reference 2) and the drafted step-C lines (46 drafted, filtered to those carrying their own graded verdict).

**No claim is made either way.** The structural expectation, untested: the gate
question only measures informativeness, and only 31 of the 42 WRONG rows are
content-free — `other_property_usage`, `wrong_sense` and `self_reference` rows
are *specific and checkable*, so on an informativeness question they score high
and the ceiling is the 0.58 base rate. Anyone continuing this should expect that
and split the AUC by category rather than be surprised by it.

## E4 — dream contradiction judge: **no (and not yet measurable)**

Nine contradicted proposals exist across the two T1609 dry runs (6 in
`nlm-resample500`, 3 in `nlm-dream-dryrun`, no fact id in common). Six carry
human labels — 3 TP / 3 FP, i.e. the 50 %-against-a-90 %-gate relabel already on
record — quoted from the vault change history and mapped to fact ids by the class
names it names (`Journey-declutter reversal`, `TRIBE misdescription`,
`KNXT live-vs-building`; `fail-soft/fail-safe agreement`, `stale
NavFlow-elimination quote`, `spec-instruction-as-negation`). The other three are
reported as **unlabeled**; no label was invented for them.

Clef was given exactly what a cheap second-opinion layer would see — the stored
fact and the evidence quote the primary judge grounded on — not the full
transcript, so this is a confirm/deny layer, not a re-judge of the gemma pass.
Three phrasings, both models. AUC of the contradict signal against TP/FP, n=6:

| phrasing | clef-flash | clef-oQ4e |
| --- | --- | --- |
| `D1_noul` "does the evidence contradict the fact" | 0.556 | 0.778 |
| `D2_score` "how wrong would a reader be" | 0.667 | 0.556 |
| `D3_noulStrict` "opposite, in the same terms" | 0.556 | 0.667 |

Every cell sits where chance sits with 3 vs 3 labels (one swap of a single pair
moves AUC by 0.11), the two models disagree about which phrasing is better, and
the `score` variant barely uses its scale: the middle and top levels carry
0.63–0.87 combined probability on *every* pair, TP and FP alike. **Neither model
separates the 3 TPs from the 3 FPs on this evidence.** Consistent with why the
FP classes are hard: they fail on "different words, same thing" and
"instruction read as negation", which a fact-and-quote pair cannot resolve —
that is the same reason the E4 review found no predicate or rule that separates
real replacements from distinct facets.

What labeling would make this decidable: precision must beat 0.90, so the
quantity to estimate is a proportion near 0.5 with a useful bound — ~96 labeled
contradicted proposals for a ±0.10 Wilson half-width. The dry runs flag 6 of 499
judged facts (1.2 %), so that is **≈8,000 judged facts, i.e. ~16 more 500-sample
dry runs, every flagged pair read by a human** — about the same labeling effort
the 50 %-precision verdict already cost, times sixteen. Until then the pass
stays triage-only and the human adoption queue is the right design (it works at
50 % precision precisely because a human is in it), so this experiment should be
re-run alongside the labeling, not before it.

## Method notes and corrections

- **Per-model fitting changed the answer.** Fitting the 27B's panel with a flash
  threshold, or flash with the frozen `importance < 1.5`, flips the ranking
  comparison (section E1, point 1). Every number here is fitted and read on
  disjoint rows per model.
- **One phrasing is not a measurement of a model.** The score questions were
  written with ordered, behavioural levels rather than `noul`, per the earlier
  finding that `score` separated far better; that held again in E4, where the
  3-level-of-wrongness question beat both yes/no phrasings on flash.
- **A second session ran this same task in this same worktree while this
  evaluation was in flight** (`t1778-flash-gate-replay.ts`,
  `t1778-flash-relevance.ts`, `t1778-flash-report.ts`, `lib/clef-direct.ts`
  appeared at 20:30–20:37 with files of mine already present, and two `pi`
  session logs exist for this worktree). Both sessions' calls share one oMLX, so
  each contaminated the other's latency, and the other session's
  `t1778-flash-report.ts` does not typecheck, which breaks the repo-wide
  `npm run typecheck` independently of this work. T1778 should be run once.
- The `.eval/` caches were verified sha1-identical to their `~/.nlm` sources
  before use; nothing under `~/.nlm` was written, and the 1.8 GB database
  snapshot used to re-extract the session bodies lived inside the worktree
  (`.eval/db.sqlite`, deleted straight after) rather than a temp dir.

## Verdicts

| Use | Verdict | Evidence | Integration point if adopted |
| --- | --- | --- | --- |
| E1 ingest gate | **no** — shadow at most | AUC parity (0.906 yield / 0.962 audited vs 0.926 / 0.947), but 0.7 % of decisions lost above the 0.5 % rule, and cost ≈ break-even at best on a long-heavy mix; params are not transferable | `src/core/classifier/ingest-gate.ts:makeClefIngestGate` + regenerated `gate-model-params.ts` |
| E2 recall hook | **no** (budget) | 1.40 s at 5 items, 2.72 s at 10 against a 1000 ms hook budget; accuracy not measured | n/a — `recallGateQuestions` stays dead |
| E3 populate gate | **not measured** | no answers collected; expected ceiling ≈ 0.58 base rate on an informativeness question | n/a |
| E4 dream judge | **no**, and blocked on labels | n=6, both models ≈ chance on all three phrasings; ~8,000 judged facts (= ~96 labels) needed to test precision ≥ 0.90 | n/a until labeled props exist |
