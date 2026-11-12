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
Caches went to the git-ignored `.eval/` — copies of the `~/.nlm` gold files plus what the collectors append — and are deleted once the numbers are in, so the commands above regenerate them. The supplement below re-ran `t1778-e2-recall.ts`, `t1778-e3-populate.ts`, `t1778-e4-dream.ts` and `t1778-bench.ts` against caches rebuilt the same way, then deleted `.eval/` again; nothing under `~/.nlm/` was written by either run.

## Headline

**clef-flash ranks as well as the 27B, and it is about 3.4× cheaper per call —
and that still does not clear the bar, because the gate's cost is paid on every
session and the gate only fires on the short ones.** Verdicts: ingest **no /
shadow only**, recall hook **no (budget, and now also accuracy)**, populate
**no for flash; the 27B is the only candidate there**, dream judge **no
(and not yet measurable)**. Details below, with what is *not* established stated
next to what is.

> Updated by the second run the same evening (21:45–22:05, oMLX otherwise idle):
> **E2 accuracy and all of E3 are now measured, and the latency table has a clean
> window.** Read the [supplement](#supplement-second-run-same-day-e2-accuracy-e3-and-a-clean-latency-window)
> first; where it disagrees with a section below, the supplement is the later
> measurement. E1 and E4 are unchanged and reproduce exactly.

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

## E2 — recall relevance gate: **no (budget; accuracy later measured, same verdict)**

> *Superseded below:* accuracy was collected in the quiet window that followed —
> [supplement, E2](#e2--recall-relevance-gate-now-measured-and-it-does-not-change-the-verdict).
> The budget verdict held; the 27B out-ranked flash (0.870 vs 0.738 on the same 45
> holdout items) and neither kept enough informed context at its tune-chosen
> threshold to be worth adopting.

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

## E3 — populate precision gate: **27B only; flash no**

> *Superseded below:* 78 holdout statements were scored by both models after this
> was written — [supplement, E3](#e3--populate-gate-measured-27b-only). The
> predicted ≈0.58 ceiling did not hold: on a 50 % base-rate holdout the 27B
> reaches 69.4 % precision and flash about 53 %, while a free lexical rule beats
> both but cannot meet the keep-rate constraint.

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
- **A second session ran this same task in this worktree while this evaluation
  was in flight.** Both hammered one oMLX, which is why the latency table above
  has a 0.25 s cell and an 18.8 s cell for the same payload; the
  [supplement's](#latency-quiet-host-5-reps-serial-one-checkpoint-at-a-time) quiet
  window is the one to quote. That session's caches were destroyed when it cleaned
  up mid-run, and its four duplicate collectors
  (`t1778-flash-gate-replay.ts`, `t1778-flash-relevance.ts`,
  `t1778-flash-report.ts`, `lib/clef-direct.ts`) have since been deleted —
  `t1778-e1-*`, `t1778-e2-recall.ts`, `t1778-e3-populate.ts`, `t1778-bench.ts`
  are the only T1778 collectors in the tree, and the repo typechecks with them.
  T1778 should be run once.
- The `.eval/` caches were verified sha1-identical to their `~/.nlm` sources
  before use; nothing under `~/.nlm` was written, and the 1.8 GB database
  snapshot used to re-extract the session bodies lived inside the worktree
  (`.eval/db.sqlite`, deleted straight after) rather than a temp dir.

## Verdicts

| Use | Verdict | Evidence | Integration point if adopted |
| --- | --- | --- | --- |
| E1 ingest gate | **no** — shadow at most | AUC parity (0.906 yield / 0.962 audited vs 0.926 / 0.947), but 0.7 % of decisions lost above the 0.5 % rule, and cost ≈ break-even at best on a long-heavy mix; params are not transferable | `src/core/classifier/ingest-gate.ts:makeClefIngestGate` + regenerated `gate-model-params.ts` |
| E2 recall hook | **no** (budget, and accuracy too) | 1.39 s at 5 items, 2.71 s at 10 against a 1000 ms hook budget (clean window); measured holdout AUC 0.738 flash / 0.870 27B on 45 items, and at the tune-chosen threshold flash keeps 7 of 13 informed items, the 27B 4 of 13 | n/a — `recallGateQuestions` stays dead |
| E3 populate gate | **no for flash**; the 27B is the only candidate | 54-statement holdout, base rate 50.0 %. AUC 0.764 (flash) vs 0.826 (27B); at the ≥90 %-keep point precision 51–54 % (flash) vs 69.4 % (27B, keeping 92.6 % of CORRECT and removing 59.3 % of WRONG). The free lexical rule reaches 73.9 % but only by dropping 37 % of the correct rows, which the ≥80 %-keep constraint forbids | n/a for flash; the 27B, if pursued, belongs in the populate draft step, not in nlm |
| E4 dream judge | **no**, and blocked on labels | n=6, both models ≈ chance on all three phrasings; ~8,000 judged facts (= ~96 labels) needed to test precision ≥ 0.90 | n/a until labeled props exist |

---

## Supplement (second run, same day): E2 accuracy, E3, and a clean latency window

The session that ran this in parallel with the first one was stopped at 21:20, its
scratch deleted, and its four duplicate scripts removed from the tree
(`t1778-flash-*.ts`, `lib/clef-direct.ts`) — every number below comes from the
protocol scripts listed at the top of this document, unchanged. The host was
quiet from 21:45, which is the window the latency section above asked for. Two
things to note before the tables: the repo gained one fix in
`t1778-e3-populate.ts` (`freeRule` was a `const` arrow used by `report()` from a
top-level call before its initialiser — a TDZ crash, so `--report=go` could not
run at all; it is now a hoisted function declaration), and no `src/` file was
touched by either run.

### Latency, quiet host, 5 reps, serial, one checkpoint at a time

Same bench, `npx tsx scripts/eval/t1778-bench.ts --reps=5 --model=both`. The p50
and the min agree to within a few milliseconds on every row, which is what the
first window could not manage — these are quotable.

| Payload | flash p50 | 27B p50 | ratio |
| --- | --- | --- | --- |
| warm-up call (1 q, one line) | 240 ms | 542 ms | 2.3× |
| gate panel, one-line state (10 q, 1127 tok) | 993 ms | 4644 ms | 4.7× |
| gate panel, short session (10 q, ~1.15k tok) | 1009–1024 ms | 3413–3493 ms | 3.4× |
| gate panel, 15k session (10 q, 5.1–5.6k tok) | 4427–4816 ms | 15176–16957 ms | 3.4× |
| recall hook, 1 item (376 tok) | 353 ms | 1967 ms | 5.6× |
| recall hook, 5 items (1601 tok) | 1385 ms | 8088 ms | 5.8× |
| recall hook, 10 items (3144 tok) | 2707 ms | 10912 ms | 4.0× |
| populate page, 3 statements (559 tok) | 510 ms | 2930 ms | 5.7× |
| dream pair (240 tok) | 246 ms | 841 ms | 3.4× |

Load reached 18 during the 27B block mostly because of this bench itself; the
flash block ran at 4–13 and its reps were still tight. Two corrections to the
table above, both in flash's favour, neither decisive:

- **The hook is over budget at 5 items, not just at 10.** 1385 ms against
  1000 ms total. At a single candidate item it is 353 ms, so "score only the
  top hit when the retriever is unsure" is the only shape that fits the hook at
  all — and one item is also where the label noise is worst.
- **The ratio is bigger on the cheap payloads** (4.7–5.8×) than on the 15k-char
  panel (3.4×), because long-prompt prefill is shared work. The first window's
  single ratio of 3.4× was really the *panel* ratio. Anything that runs on short
  state — hook, populate, dream — gains more from the swap than E1 does.

Collection throughput, which is what actually limits an eval of this size: the
gate panel at parallel 4 measured p50 21 s per call against 4.4 s serial, so
oMLX is serialising the panel's prefill and concurrency buys nothing. Flash
answers **~0.2 sessions/s**, i.e. the full 1,220-session panel is a
**~90-minute scheduled job**, not an interactive one. This run stopped at 75
sessions for that reason and kept the first session's 375-session fit.

### E2 — recall relevance gate: now measured, and it does not change the verdict

`--report=go` output: 74 prompt calls per model per phrasing, holdout 45 items
(13 informed, 32 unused), threshold chosen on tune at 90 % positive retention.

| Model | phrasing | holdout AUC (tune) | positives kept | negatives skipped | call p50 |
| --- | --- | --- | --- | --- | --- |
| flash | R1_generic | **0.738** (0.818) | 7 / 13 | 21 / 32 | 782 ms |
| flash | R2_productLine | 0.663 (0.883) | 8 / 13 | 17 / 32 | 751 ms |
| flash | R3_lossIfDropped | 0.445 (0.602) | 12 / 13 | 5 / 32 | 777 ms |
| 27B | R1_generic | **0.870** (0.918) | 4 / 13 | 30 / 32 | 2562 ms |
| 27B | R2_productLine | 0.791 (0.857) | 8 / 13 | 26 / 32 | 2562 ms |
| 27B | R3_lossIfDropped | 0.690 (0.827) | 5 / 13 | 24 / 32 | 2734 ms |

- **The 27B is clearly the better ranker** (0.870 vs 0.738 on the same 45 items,
  and it wins every phrasing). This is the one experiment where flash is
  materially weaker, and the ordering is the opposite of E1, where refitting
  closed the gap: here there is no fit step to hide behind — the raw score *is*
  the gate.
- **Neither model is usable at this label volume.** 13 positives on holdout; the
  tune-chosen threshold keeps 7 of 13 informed items on flash and 4 of 13 on the
  27B. A gate that throws away half to two-thirds of the useful context to skip
  some of the rest is worse than the `relativeFloor` rule it would replace.
- **Flash's phrasing choice did not transfer**: R2 was the best flash phrasing on
  tune (0.883) and one of the two worst on holdout (0.663). With 32 tune
  positives, phrasing selection on this gold is fitting noise — do not read the
  per-phrasing columns as three measurements.
- The label caveat stands and bites here: `unused` includes relevant context the
  response simply did not use, so these AUCs are floors. The verdict, though,
  does not depend on the labels — 1385 ms for a 5-item hook against a 1000 ms
  budget already decided it.

### E3 — populate gate: measured, 27B only

The holdout side of the base sample is **54 statements, 27 CORRECT / 27 WRONG,
so the base rate is 50.0 %**, split by the 86 subjects' id-hash; the threshold
comes from the tune side at 90 % CORRECT retention. (The step-C drafted lines are
a separate, much smaller split below, base rate 87.5 % — do not read the two
together.)

| Model | phrasing | holdout AUC (tune) | CORRECT kept | precision | WRONG removed |
| --- | --- | --- | --- | --- | --- |
| flash | P1_informative | **0.764** (0.597) | 96.3 % | 53.1 % | 14.8 % |
| flash | P2_pageworthy | 0.667 (0.626) | 96.3 % | 54.2 % | 18.5 % |
| flash | P3_notAssumable | 0.683 (0.635) | 92.6 % | 51.0 % | 11.1 % |
| 27B | P1_informative | 0.804 (0.687) | 96.3 % | 57.8 % | 29.6 % |
| 27B | P2_pageworthy | 0.793 (0.705) | 96.3 % | 56.5 % | 25.9 % |
| 27B | P3_notAssumable | **0.826** (0.862) | 92.6 % | **69.4 %** | **59.3 %** |
| — | free rule (multi-word, not a bare token), same 54 rows | 0.704 | **63.0 %** — infeasible | 73.9 % | 77.8 % |

- **The structural prediction in the section above was wrong in an interesting
  way.** It expected an informativeness question to be fooled by the
  `other_property_usage` / `wrong_sense` / `self_reference` rows and to sit at
  the base rate. On the holdout the question does rank those rows below the
  correct ones — 0.826 AUC with the wrong-category rows present — so the ceiling
  is the *operating point*, not the question.
- **Flash buys almost nothing at the operating point.** 51–54 % precision against
  a 50.0 % base rate — it ranks (AUC 0.764) but the threshold that keeps 92–96 %
  of CORRECT removes only 11–19 % of WRONG, so it earns about two points over
  doing nothing. The 27B clears the same bar (69.4 % precision, 92.6 % of CORRECT
  kept, 59.3 % of WRONG removed) — the reverse of E1, where the cheap model only
  kept up after being refitted.
- **The free rule beats every Clef answer on precision, and is not admissible at
  this constraint.** It keeps 63.0 % of CORRECT, so it fails the ≥80 %-keep rule
  outright; the only rule meeting the constraint that costs nothing is *keep
  everything*, i.e. the 50.0 % base rate. If the populate owner will trade a
  third of the correct statements for 73.9 % precision at zero cost, the lexical
  rule is the thing to adopt and no model is needed. That is a product decision,
  not a model one, and it is the real conclusion of E3.
- **The step-C drafted-line set (24 holdout statements, 21 correct, base rate
  87.5 %) is too small to conclude anything**: the free rule there reports 93.3 %
  precision and the models' 85–88 % is *below* their base rate, so those columns
  say nothing. every Clef row there keeps 100 %/90 % of CORRECT at 85–88 %
  precision with 0 % of WRONG removed, and the free rule reports 93.3 %
  Twelve wrong rows in the whole set — three on the holdout side — will not
  resolve a precision difference near 0.9. Do not quote those numbers.
- Statement-category counts on the base sample: content_free 198,
  other_property_usage 30, wrong_sense 30, self_reference 12 (statements, not
  pages).

### E1 and E4 — what the second run confirmed

E4 was re-run through `t1778-e4-dream.ts --report=go` and reproduced the table
above to the third decimal (flash D1 0.556 / D2 0.667 / D3 0.556, 27B 0.778 /
0.556 / 0.667 on the same 3 TP / 3 FP). Nothing about that verdict changes: the
labels are the binding constraint, not the model. E1 was re-collected rather than
reused, and after 75 sessions hit the throughput wall quoted above; the
first run's 375-session, freshly-split fit stands as the E1 evidence.

### What one more run should do

1. Schedule the full 1,220-session flash panel (~90 min, `--parallel=1`; higher
   concurrency does not help) and refit E1 on the T644 split, so flash and the
   27B are read on the *same* rows the published numbers used.
2. Get ≥96 human-labeled contradicted proposals before touching E4 again.
3. If populate is still on the table, ask the owner the keep-rate question first;
   the answer decides between a free rule and a 27B call, and flash is not an
   option either way.
