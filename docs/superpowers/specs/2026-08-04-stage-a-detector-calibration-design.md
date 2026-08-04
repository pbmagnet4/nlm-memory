# Stage A: calibrating the re-derivation detector against ground truth

Date: 2026-08-04. Status: design, pre-registration section binding before any
labeling run. Implements Stage A of
`2026-08-03-re-derivation-detection-design.md`, and revises two of that spec's
findings.

## What changed since the parent spec

The parent spec's Stage A said: sample across the Jaccard range, hand-label,
report precision and recall at several thresholds, and expect the answer to be
"the floor drops and a semantic leg gets added."

Direct inspection of the corpus on 2026-08-04, before any labeling, contradicts
the premise that sweep rests on. Three measured findings, each reproducible from
the live SQLite corpus.

### Finding A: the detector's positives are dominated by one recurring ritual

The 15 pairs the detector flags in the 90-day window, resolved to their decision
text, are mostly subagent code-review sessions whose entire decision content is a
task-approval line:

| J | Session A → decision | Session B → decision |
|---|---|---|
| 1.00 | Review of nlm-memory workstream filter implementation → "Task 6 approved" | Review of Task 6 for nlm-memory → "Approved Task 6" |
| 0.80 | Review of Task 2 implementation → "Approved Task 2 implementation" | Review of MatrixClient implementation → "Approved Task 2 (MatrixClient implementation)" |
| 0.75 | Review of query intent telemetry task → "Task 3 approved" | (pairs against the Task 6 sessions on {task, approved}) |

Approving Task 2 of the Matrix plan is not re-deriving the approval of Task 2 of
an unrelated plan. This is one recurring activity shape, not one repeated
decision. 12 of the 15 are this class.

The parent spec asserted "the pairs it finds look real, precision looks good"
on the strength of three rows in its own evidence table. Row 2 of that table is
this artifact.

### Finding B: Jaccard is confounded with decision-set size

Over the real labelable frame (definition below), binned by the detector's own
pooled Jaccard:

| J band | pairs | subagent-side share | mean tokens/side | mean decisions/side |
|---|---|---|---|---|
| J = 0 | 25,998 | 71.3% | 21.7 | 2.12 |
| (0, .05) | 208,065 | 47.9% | 55.4 | 5.83 |
| [.05, .15) | 232,397 | 42.0% | 56.9 | 5.86 |
| [.15, .25) | 2,235 | 66.8% | 27.8 | 2.51 |
| [.25, .35) | 170 | 89.7% | 14.7 | 1.27 |
| [.35, .50) | 37 | **100.0%** | 10.5 | 1.05 |
| [.50, 1] | 15 | 80.0% | 10.3 | 1.50 |

Baseline subagent-side share across the frame is 46.4%.

The relationship is monotone. A pair of one-decision, ten-token sessions clears
J = 0.5 on shared boilerplate. A pair of six-decision, fifty-seven-token sessions
cannot clear J = 0.15 however identical their underlying reasoning, because
pooled Jaccard's union grows with content while the intersection does not.
The incumbent detector is, structurally, a short-subagent-session detector.

This inverts the parent spec's expected conclusion. Lowering the floor does not
recover the missed long-session re-derivations; it admits more boilerplate first.

### Finding C: the tokenizer strips no stopwords, and that shapes the distribution

`toks()` in `src/core/metrics/re-derivation.ts` splits on `\W+` and keeps every
token. Unrelated sessions therefore share "the", "to", "for", "and". Recomputing
the same frame with a standard English stopword list:

| J band | raw | stopwords stripped |
|---|---|---|
| J = 0 | 25,998 | **178,679** |
| (0, .05) | 208,065 | 257,109 |
| [.05, .15) | 232,397 | **32,233** |
| [.15, .25) | 2,235 | 702 |
| [.25, .35) | 170 | 141 |
| [.35, .50) | 37 | 35 |
| [.50, 1] | 15 | 18 |

Roughly 87% of the apparent signal in the band holding half the frame was
function words. The J ≥ 0.35 tail barely moves, because those pairs share
*content* words — which is Finding B, not this one. Two independent defects;
stopword removal fixes only the noise floor.

### Finding D (Stage B correction): two-thirds of the denominator is structurally dead

`computeReDerivationRate` increments `eligible` as soon as two sessions share an
entity, before it looks at decisions. Measured over the 90-day window:

- entity-sharing pairs: 1,916,500 — the reported denominator
- of those, at least one side carries zero decisions: **1,276,021 (66.6%)**
- linked by a `continues`/`supersedes` edge: 82
- gap ≤ 7 days: 171,480
- **labelable frame: 468,917**

(Every count in this document is one measurement run against a live, continuously
ingesting corpus; a later run drifts by a few hundred pairs. See the frozen-frame
note under Sampling frame.)

A pair with a decisionless side can never be a re-derivation. The parent spec
attributes the untrendable rate to quadratic pair growth, which is real, but
two-thirds of the inflation is this instead. Stage B should exclude decisionless
sessions from the denominator regardless of which unit the metric ends up using.

## What Stage A now measures

Not "where should the Jaccard floor sit." That question presumes the feature is
sound. Stage A compares **candidate feature designs** against a labeled set, and
the incumbent configuration is one entry in that comparison rather than the
baseline everything is tuned around.

Sweep dimensions:

1. **Tokenizer** — raw (incumbent) vs stopword-stripped
2. **Matching unit** — pooled decision bag (incumbent) vs max over decision-to-decision pairs
3. **Signal** — lexical Jaccard vs embedding cosine vs max of both
4. **Minimum decision tokens per side** — 0 (incumbent), 5, 10, 20
5. **Gap days** — 0, 3, 7 (incumbent), 14, 30
6. **Entity requirement** — on (incumbent) / off
7. **Subagent sessions** — included (incumbent) / excluded

Dimension 4 attacks Finding B directly. Dimension 5 matters more than the parent
spec assumed: at J' ≥ 0.15 the gap ≤ 7d cohort holds **2,067** pairs against the
**896** inside the frame, so `GAP_DAYS` currently discards 2.3× more
high-similarity mass than it admits, and nobody has checked whether that mass is
genuine. (On raw J the same asymmetry reads 178 discarded against 15 kept.)

## Sampling frame

Window: 90 days, matching the production detector's operating regime.
7,478 sessions, 3,052 decision-bearing.

Frame: unordered session pairs where **both** sides carry at least one decision,
the pair shares at least one entity, the gap exceeds 7 days, and no
`continues`/`supersedes` edge links them. **468,917 pairs.**

Probe pools sit outside the frame by construction and are sampled separately, so
that each precondition gets tested rather than assumed.

**The frame is frozen at sample time.** Two measurement runs eleven minutes apart
during this design disagreed by 466 pairs on the same query, because the daemon
ingests continuously and `datetime('now','-90 days')` slides with every
invocation. The sampler therefore resolves the window to literal ISO timestamps
once, writes them and every stratum population into `frame.json`, and every
downstream stage reads that file rather than re-querying. A weighting denominator
recomputed after the labeling run would silently disagree with the sample it
weights.

## Strata

Stratified on **stopword-stripped** pooled Jaccard (`J'`), because Finding C
establishes raw J as mostly noise and `J'` is the better auxiliary variable for
concentrating plausible positives.

Within every stratum, draws are balanced across decision-set-size terciles.
Without that balance the high-`J'` strata resolve to pure boilerplate (Finding B)
and the calibration measures an artifact.

| Stratum | Definition | Population | n |
|---|---|---|---|
| A1 | J' ≥ 0.35 | 53 | all 53 |
| A2 | J' ∈ [0.15, 0.35) | 843 | 45 |
| A3 | J' ∈ [0.05, 0.15) | 32,233 | 45 |
| A4 | J' ∈ (0, 0.05) | 257,109 | 40 |
| A5 | J' = 0, excluding P3's slice | 176,892 | 30 |
| P1 | gap ≤ 7d, unlinked, J' ≥ 0.15 | 2,067 | 30 |
| P2 | **zero** shared entities, top decile by decision cosine | 401,581 of 4,015,813 | 30 |
| P3 | J' = 0, top 1% by decision cosine | 1,787 | 30 |

**303 pairs.** P3 is the case the parent spec named as invisible — a decision
re-made in different words — and it is the single stratum most likely to change
the design's conclusion.

"Top decile" and "top 1%" are ranks within the named pool, computed from the
frozen frame; they are not absolute cosine thresholds, so the populations above
are exact rather than dependent on a cutoff nobody has picked yet.

Every sampled pair carries the full feature vector regardless of which stratum
drew it: raw J, J', pooled and max-pair variants of each, decision counts and
token counts per side, subagent flags, gap days, shared-entity count, and
max-decision-pair cosine. One labeling pass then scores all seven dimensions.

## Weighting

Precision at any configuration is estimable within strata directly. Recall
requires population positives = Σ over strata of (stratum size × observed
positive rate), which is why `J'` rather than raw J is the stratification
variable: it concentrates plausible positives into strata we can afford to sample
densely, tightening the interval that would otherwise be dominated by A4 and A5.

Reported recall is **conditional on this frame**, with a separately stated upper
bound on what the sparsely-sampled strata could hide. It is not an absolute
recall number and will not be written up as one.

## Labels

Five-way, collapsing to binary for scoring. The non-genuine categories exist
because Findings A and B identified them as the dominant failure modes; a binary
rubric would have scored the Task-N-approved cluster as ambiguous rather than
as the specific artifact it is.

- **GENUINE** — B re-solves a question A already settled, with no sign B had A available. *Positive.*
- **REVISIT** — B knowingly changes or refines A's decision. Supersedence, not re-derivation.
- **RITUAL** — same recurring activity shape, different subject ("Task 6 approved" / "Approved Task 2").
- **SAME-TOPIC-DIFFERENT-DECISION** — shared subject, genuinely different question settled.
- **DUPLICATE** — near-identical sessions, likely an ingest artifact rather than behavior.

DUPLICATE earns its own category because the 2026-05-17 / 2026-05-24
property-validate pair carries three verbatim-matching decisions seven days
apart, and NocoDB #416 has 257 confirmed duplicate session rows in the corpus.
Counting ingest artifacts as re-derivations would corrupt the metric in the same
direction as the ritual cluster.

## Pre-registration

Binding before the labeling run. Any change after the run is disclosed in the
report.

- **Frame and strata**: exactly as tabled above. The window resolves to literal timestamps at sample time and is frozen in `frame.json`; populations may differ from this document by the corpus growth between writing and running, and the frozen file is authoritative.
- **Seed**: 20260804, via `deriveSeed`/`makeRng` in `scripts/eval/lib/recall-impact-replay-lib.ts` — the repo's one audited PRNG, not a reimplementation.
- **Judge**: `google/gemma-4-26b-a4b-qat` at `$NLM_EVAL_JUDGE_BASE_URL`, temperature 0, `max_tokens` 400, `reasoning_effort: none`. Verified live 2026-08-04 (`reasoning_tokens: 0` on a control call).
- **Blinding**: the judge sees two dated sessions' labels, decision text, and transcript excerpts, plus the rubric. It never sees Jaccard, cosine, stratum, subagent flag, or the incumbent detector's verdict.
- **Consistency**: double-judge subsample n = 30 against `qwen/qwen3.6-35b-a3b`, agreement reported.
- **Human check**: Edward labels 20 pairs (10 judge-positive, 10 judge-negative, blind to the verdict). Agreement is reported as the headline caveat on every downstream curve.
- **Analysis plan**: weighted precision/recall per configuration across all seven dimensions, the Pareto set, and two recommended operating points — a counting threshold for the Stage B metric and a strictly higher firing threshold for the Stage C interrupt, per open question 3 of the parent spec.

The judge call reuses the request path in `scripts/eval/recall-impact-replay.ts`
(which sends `max_tokens` and `reasoning_effort`), not `scripts/eval/judge.ts`
(whose `streamChatOnce` sends neither). That path is lifted into
`scripts/eval/lib/` so both harnesses share one implementation.

## Components

| File | Responsibility |
|---|---|
| `scripts/eval/lib/re-derivation-features.ts` | Pure feature computation for a session pair: tokenizers, pooled and max-pair Jaccard, cosine, size stats. No I/O. |
| `scripts/eval/re-derivation-sample.ts` | Builds the frame and probe pools from SQLite, emits `sample.jsonl` plus `frame.json` (stratum populations, for weighting). |
| `scripts/eval/re-derivation-label.ts` | Runs the blind judge over the sample, disk-cached by `sha256(model + prompt)`. Emits `labels.jsonl` and the 20-pair human spot-check file. |
| `scripts/eval/re-derivation-calibrate.ts` | Sweeps the seven dimensions against labels with stratum weighting. Emits curves, Pareto set, two operating points. |
| `reports/re-derivation/2026-08-04-stage-a-calibration.md` | Readout. |

Decision markers carry no embeddings (`markers` has no vector table). The
semantic leg needs a one-off pass with the bundled ONNX embedder via
`src/llm/build-embedder.ts` over in-window decision text: session-pooled
embeddings for the auxiliary variable, max-decision-pair cosine computed only for
the ~303 sampled pairs.

Typecheck coverage for `scripts/` landed 2026-08-03 (`tsconfig.scripts.json`),
so these files are gated by `npm run typecheck` from the first commit.

## Out of scope

- Changing the detector. Stage A measures; the rewrite follows from what it finds.
- Repairing the duplicate-session corpus (#416). Stage A labels duplicates so they can be excluded from scoring; it does not fix ingest.
- The Stage B denominator fix. Finding D records it; Stage B implements it.

## Open questions

1. **Does the subagent cohort belong in the metric at all?** Dimension 7 measures the cost of excluding it, but the product question — whether a subagent re-deriving something counts as the operator re-deriving it — is Edward's call, not the data's.
2. **Whether `J' = 0` plus high cosine (P3) yields any positives.** If it does, the lexical leg is not repairable and the detector becomes embedding-first. If it does not, a cleaned-up lexical detector may be sufficient and much cheaper.
