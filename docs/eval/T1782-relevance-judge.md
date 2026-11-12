# T1782 step 3 — can Clef judge recall relevance offline? (evaluation only)

Question: the recall hook injects session memories under a prompt and nothing measures
whether the injected memory had anything to do with that prompt. A nightly
**relevance-precision** metric ("what share of what we injected was actually relevant")
needs a cheap judge. Can Clef be that judge, offline, without a frontier model in the
loop?

Nothing in `src/` changed. One script, one document; the answer cache lived in
git-ignored `./.eval/` and is deleted after this commit.

Verdict line: **yes on the ranking — flash holdout AUC 0.89 (0.90 on unique pairs) clears
the 0.80 bar — but as a metric it reads low, and it is not yet good enough to gate
injection on.**

Script: `scripts/eval/t1782-relevance-judge.ts` (reuses `scripts/eval/lib/clef-direct.ts`
for the direct-oMLX call, `lib/clef-stats.ts` for the split/AUC, `lib/t1778-stats.ts` for
Spearman).

```
npx tsx scripts/eval/t1782-relevance-judge.ts --model both                      # collect + report
npx tsx scripts/eval/t1782-relevance-judge.ts --model both --report-only        # offline, from cache
npx tsx scripts/eval/t1782-relevance-judge.ts --model both --report-only --dedupe
```

## Data

`~/.nxtos/state/t1782/eval-set.jsonl` (step 1 + step 2 of T1782): real (prompt, injected
memory) pairs from `~/.nlm/hook-log.jsonl`, synthetic e2e/probe prompts removed.

- 228 pairs, 110 distinct prompts, 154 distinct memories, hook traffic 2026-10-15 … 11-12.
- Prompt is the hook's `promptPreview` (mean 175 chars, max 262); the memory side is the
  `sessions` label plus a summary capped at ~1.2k chars (max 358 here).
- Labels: a judgment model scored each pair 0-3 against a rubric (3 same task, 2 same
  system related, 1 keyword overlap only, 0 unrelated); the metric's positive class is
  `relevant = relevance >= 2`. Mix: 0:98, 1:50, 2:34, 3:46 → 80 relevant (35.1%).
- 43 rows are repeats of a (prompt, memory, hit-rank) triple — the hook log re-records the
  same injection when a conversation is re-prompted — so 185 unique triples. `--dedupe`
  is the control.

Split: `splitOf(prompt)` (sha256 of the prompt, parity of the first byte), so every memory
judged under a prompt lands on one side. tune 53 prompts / 114 pairs / 45 relevant;
holdout 57 prompts / 114 pairs / 35 relevant.

## Method

T1778's tuning shape: `state` is the prompt; **one call per prompt** (see chunking below),
**one `score` question per injected memory**, the memory's label and summary inside the
question instructions, four ordered criteria mirroring the rubric:

0. Unrelated: a different task in a different system; nothing here bears on the prompt.
1. Keyword overlap only: shares words, paths or tools, but a different task/system.
2. Same system, related: the same project, tool or subsystem, work it could build on.
3. Same task: directly about the task, decision, value or status the prompt is about.

Three phrasings ride in the same call, so the wording choice costs no extra state read:
`direct` ("How relevant is this memory to the prompt?"), `dev` ("Would a developer handling
this prompt want this memory open?"), `same` ("Is this memory about the same task or the
same system as the prompt?"). Their scores correlate at r 0.95-0.99, i.e. they are the same
signal; the choice does not matter.

Per model and phrasing the best-F1 threshold is fitted on **tune only** (tie → the stricter
threshold) and only then read on holdout. Reported: AUC (relevant vs not), Spearman rho
against the 0-3 label, precision/recall/F1 at that threshold, share kept, the mean score per
label, and what the four known hub memories score.

Chunking: one prompt in this set carries 29 injected memories; 29 x 3 = 87 score questions
came back `HTTP 413 Request Entity Too Large`, so memories are chunked 8 per call (24
questions). That is 115 calls per model, not 110, and the cache key is the (prompt, memory
slice) hash, so a rerun only redoes what failed. `--chunk 1` re-measures one memory per
call.

Baseline: the hook's own retrieval score, joined back out of `hook-log.jsonl` by
(ts, `wouldInject` position, memory id) — 228/228 pairs joined, so the comparison is
same-population, same split, same fit rule.

Cost, measured while other MSM3 work ran (no quiet windows waited for). `vm.loadavg` at the
three run starts: `{19.6 17.8 13.6}`, `{17.1 16.8 14.3}`, `{10.8 14.3 13.6}`; it fell to
`{4.2 4.9 6.8}` by the end.

| run | calls | questions/call | p50 | p95 | max | load1 seen | serial total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| flash `clef-flash-oQ8e`, 8 memories/call | 115 | 5.9 | 7.1 s | 20.4 s | 26.4 s | 4.6-19.2 | 955 s |
| base `clef-oQ4e`, 8 memories/call | 115 | 5.9 | 10.4 s | 31.6 s | 45.9 s | 5.1-23.3 | 1515 s |
| flash, 1 memory/call | 185 | 3.0 | 1.7 s | 2.0 s | 3.2 s | 3.0-10.8 | 317 s |

Every call succeeded (0 errors) and the mean state was 181 chars. A byte-identical rerun of
12 calls reproduced 60 question scores with 17 differences, all <= 0.014 on the 0-3 scale —
effectively deterministic, so one sample per pair is enough.

## Result — flash `clef-flash-oQ8e`

228 pairs; threshold and phrasing from tune.

| phrasing | split | n | AUC (95% bootstrap CI) | Spearman | thr | P | R | F1 | kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| direct | tune | 114 | 0.971 | 0.789 | 1.23 | 0.91 | 0.91 | 0.91 | 39.5% |
| direct | holdout | 114 | 0.884 [0.79,0.95] | 0.684 | 1.23 | 0.77 | 0.66 | 0.71 | 26.3% |
| dev | tune | 114 | 0.979 | 0.828 | 1.11 | 0.86 | 0.98 | 0.92 | 44.7% |
| dev | holdout | 114 | 0.884 [0.78,0.95] | 0.678 | 1.11 | 0.79 | 0.77 | 0.78 | 29.8% |
| **same** (picked) | tune | 114 | **0.981** | 0.833 | 1.43 | 0.95 | 0.91 | 0.93 | 37.7% |
| **same** (picked) | holdout | 114 | **0.887** [0.78,0.96] | **0.698** | 1.43 | **0.83** | **0.69** | 0.75 | 25.4% |

Holdout confusion at the tune threshold: TP 24, FP 5, FN 11, TN 74.

Mean score by label (the scale is compressed — even label-3 pairs average under 2 of 3):

| label | tune | holdout |
| --- | --- | --- |
| 0 unrelated | 0.69 (46) | 0.60 (52) |
| 1 keywords | 0.99 (23) | 0.93 (27) |
| 2 same system | 1.57 (15) | 1.41 (19) |
| 3 same task | 1.93 (30) | 1.62 (16) |

## Result — base `clef-oQ4e`

| phrasing | split | n | AUC (CI) | Spearman | thr | P | R | F1 | kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| direct | holdout | 114 | 0.925 [0.86,0.98] | 0.746 | 1.43 | 0.87 | 0.74 | 0.80 | 26.3% |
| dev | holdout | 114 | 0.906 [0.82,0.97] | 0.720 | 1.32 | 0.80 | 0.80 | 0.80 | 30.7% |
| **same** (picked) | holdout | 114 | 0.908 [0.83,0.97] | 0.727 | 1.47 | 0.89 | 0.69 | 0.77 | 23.7% |

The 27B is a little better and about 1.6x the serial cost at the same load. Since a nightly
job samples rather than scores every hook event, either model is affordable; flash is the
lane to use.

## Controls

- **Unique pairs only** (`--dedupe`, 185 pairs / 65 relevant): flash holdout AUC 0.903
  (P 0.81 R 0.68 F1 0.74), base 0.912. The repeats are not carrying the result.
- **One memory per call** (`--chunk 1`, flash): holdout AUC 0.878, p50 1.7 s. Judging a
  memory beside its siblings is worth 0.009 AUC at 4x the latency. A third grouping
  (`--chunk 4`) lands at holdout AUC 0.884-0.890 and picks `dev` instead of `same`, with
  every mean score ~0.06 lower than at 8 per call. So: the result does not depend on the
  grouping, but the phrasing pick and the absolute scale drift with it by more than the
  run-to-run noise — a nightly must fix the chunk size and refit the threshold whenever it
  changes.
- **Edge slice** (label 0 vs label 3 only, holdout): flash 0.977, base 0.990. Ordering at
  the extremes is near-perfect; everything the threshold has to resolve sits on the
  1-vs-2 line, which is exactly where a rubric label and a second model can disagree.
- **Tune vs holdout** (0.98 → 0.89): only a threshold is fitted, so this is prompt
  difficulty between the halves, not leakage — but it is why the threshold is reported as
  tune-fitted and never re-tuned on holdout.

## Hub memories

The four memories that dominate one system and get injected under almost everything, and
how often the flash judge keeps them at its threshold (14 pairs, labelled relevant 1/14):

| hub | pairs | Clef keeps | label keeps | mean flash score | range |
| --- | --- | --- | --- | --- | --- |
| nxtgit session pinning | 7 | 14.3% (1) | 14.3% (1) | 1.01 | 0.73-1.54 |
| NLM classifier fix | 4 | 0% | 0% | 0.56 | 0.46-0.69 |
| Plan J | 1 | 0% | 0% | 0.44 | — |
| LinkedIn cleanup (2 labels) | 2 | 0% | 0% | 0.18 | 0.08-0.27 |

The single kept pinning pair is the one the label also calls relevant (a nxtgit land/merge
prompt). A "iPhone duo in dfw" prompt beside "Automating LinkedIn via Android Emulator"
scores 0.08. So the judge does **not** reward a memory for being frequently injected — the
failure mode a popularity-driven retriever has, and the reason this metric is worth having.

## Baseline — the hook's own retrieval score

| score | split | n | AUC (CI) | Spearman | fitted thr | P | R | kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hook `hits[].score` | tune | 114 | 0.457 | -0.066 | 0.765 | 0.39 | 1.00 | 100% |
| hook `hits[].score` | holdout | 114 | 0.592 [0.47,0.70] | 0.056 | 0.765 | 0.31 | 1.00 | 99.1% |

The retrieval score is chance-level for relevance (best-F1 throws nothing away), on
deduplicated pairs too (holdout 0.575). Clef buys roughly +0.30 AUC over the free signal;
there is no cheaper proxy already in the logs that could stand in for a judge.

## What a nightly would look like, and its known error

Sample ~40-60 hook records a night, expand `wouldInject`, one chunked call per prompt:
at the measured per-pair serial cost (4.2 s at 8 memories/call, 1.4 s one memory per call)
a 200-pair sample is ~14 minutes of flash, single-file, or ~5 minutes on the one-memory
shape — against a hook day of a few hundred records. Report the kept share as
"relevance-precision", with the fitted threshold pinned in the config so the number is
comparable night to night.

Two honest corrections the report needs:

1. **It reads low.** At the tune threshold flash says 25.4% of injections were relevant
   where the label says 30.7% (-5.3 pts; base -7.0 pts), because it misses a third of the
   relevant ones (recall 0.69). For a *metric* that level bias is the thing to fix — either
   drop the threshold (1.11, the `dev` fit, holds 77% of relevant at precision 0.79) or
   recalibrate kept-share to labelled share on a hand-checked subsample. The ordering,
   which is what a trend line uses, is the strong part.
2. **The ceiling is the label, not the judge.** Gold comes from a judgment model with the
   same rubric reading the same two fields, so "holdout AUC 0.89" is agreement between two
   model readers of the same text, not agreement with a human who saw what actually happened
   in the session. Before this number is quoted as a KPI, hand-check ~20 holdout pairs
   where Clef and the label disagree (the FNs at 1.4-1.8 are the interesting ones).

Recommended: build the nightly metric on flash at a recalibrated threshold; do **not** wire
it in as an injection gate yet — holding 91% of the truly relevant memories on holdout costs
precision 0.59 (flash, `same`), and holding 95% costs precision 0.31, i.e. the judge cannot
both keep almost everything relevant and drop most of the noise.

Not verified here: whether one model's confidence (`probabilities`/`confidence` on the
answer) or a two-of-three vote would move precision/recall; how the judge behaves on longer
summaries than this set carries; and whether the compressed scale is stable week to week,
which the nightly's own history will answer.
