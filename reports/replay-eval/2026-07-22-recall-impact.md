# Recall-impact replay eval — FULL RUN RESULT

Spec: docs/superpowers/specs/2026-07-21-recall-impact-replay-eval-design.md (bar pre-registered before the run)
Seed: 20260721 · n sampled: 100 · Date: 2026-07-22

## Identities and settings
- Generator: qwen/qwen3.6-35b-a3b via $NLM_EVAL_GEN_BASE_URL (temperature 0.1, max_tokens 1024, reasoning_effort none)
- Judge: google/gemma-4-26b-a4b-qat via $NLM_EVAL_JUDGE_BASE_URL (temperature 0, max_tokens 300, reasoning_effort none; blind, order-randomized, different model family)

## Sample
- Eligible pool exclusions: too_short=297, duplicate=148, unresolved=0, leakage=66
- Strata (month): 2026-05: 25, 2026-06: 72, 2026-07: 3
- Generation failures: 0 · Judge call failures: 0 · Malformed judge replies (counted as tie): 0

## Pre-registered gate (mechanical)

| Metric | Value | Bar | Met |
|---|---|---|---|
| decisive_rate | 0.840 | >= 0.3 | yes |
| win_rate (arm A among decisive) | 0.881 | >= 0.6 | yes |
| arm B share (HARM check) | 0.119 | <= 0.4 | yes |

**VERDICT: PASS**

## Judge consistency (double-judge subsample, n=20)
- Agreement: 20/20 (100.0%)

## Buckets (secondary, not gating)

Injected-token quartile cut points: Q1=220, Q2=235, Q3=252

| Quartile | n | win_rate | decisive_rate |
|---|---|---|---|
| Q1 | 25 | 0.864 | 0.880 |
| Q2 | 25 | 0.818 | 0.880 |
| Q3 | 25 | 0.842 | 0.760 |
| Q4 | 25 | 1.000 | 0.840 |

Fact-injection vs session-pointer rows: session-pointer=100, fact-injection=0.

## Limitations (pre-run-declared)

- Replayed prompts are the hook log's 200-char promptPreview, not the full prompt. Both arms see the identical truncated prompt, so the comparison remains internally valid, but long-prompt behavior is under-represented.
- The fact-injection bucket is structurally empty: the hook log records only session ids in wouldInject, so the facts-vs-sessions split reads fact-injection=0 for historical replay - a coverage limitation, not a result.
- The generator approximates but is not the production agent; this biases the measurement DOWN for the injection arm, so PASS is conservative.
