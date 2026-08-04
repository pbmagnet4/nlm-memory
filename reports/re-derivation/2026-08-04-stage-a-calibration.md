# Stage A: re-derivation detector calibration

Date: 2026-08-04. Spec: `docs/superpowers/specs/2026-08-04-stage-a-detector-calibration-design.md`.

> **PROVISIONAL.** Every number below rests on judge labels that have not yet
> been checked by a human. With 6 positives across 303 labelled pairs, the
> population estimate is dominated by a handful of labels in heavily-upweighted
> strata. Do not pick a threshold from this until `spot-check.md` comes back.

## Identities and settings

- Window frozen: `2026-05-06 15:16:42` .. `2026-08-04 15:16:42` (90d)
- Corpus in window: 7,451 sessions, 3,046 decision-bearing
- Judge: `google/gemma-4-26b-a4b-qat`, temperature 0, max_tokens 400, reasoning_effort none, blind
- Consistency: `qwen/qwen3.6-35b-a3b`, 30/30 binary agreement
- Embedder: `text-embedding-nomic-embed-text-v1.5`
- Labelled: 303 of 303; unparseable verdicts excluded: 0

## Finding D confirmed at full scale

The shipped detector counts a pair as eligible on entity-sharing before it looks
at decisions:

- detector-eligible pairs: **1,905,497**
- of those, at least one side carries zero decisions: **1,266,809** (66.5%)
- labelable frame after removing them: **467,267**

Two thirds of the reported denominator is pairs that can never be a positive.
This is independent of the unit question and can be fixed on its own (#427).

## Label distribution

| label | n | share |
|---|---:|---:|
| UNRELATED | 210 | 69.3% |
| RITUAL | 59 | 19.5% |
| SAME_TOPIC_DIFFERENT_DECISION | 23 | 7.6% |
| GENUINE | 6 | 2.0% |
| DUPLICATE | 3 | 1.0% |
| REVISIT | 2 | 0.7% |

| stratum | definition | population | drawn | weight | GENUINE |
|---|---|---:|---:|---:|---:|
| A1 | J' >= 0.35 | 53 | 53 | 1.0 | 2 |
| A2 | J' in [0.15,0.35) | 843 | 45 | 18.7 | 1 |
| A3 | J' in [0.05,0.15) | 32,231 | 45 | 716.2 | 1 |
| A4 | J' in (0,0.05) | 256,228 | 40 | 6405.7 | 0 |
| A5 | J' = 0, minus P3 | 176,133 | 30 | 5871.1 | 0 |
| P1 | gap <= 7d, unlinked, J' >= 0.15 | 2,066 | 30 | 68.9 | 2 |
| P2 | zero shared entities, top 5000 by pooled cosine | 5,000 | 30 | 166.7 | 0 |
| P3 | J' = 0, top 1% pooled cosine | 1,779 | 30 | 59.3 | 0 |

## The incumbent configuration

`rawPooled >= 0.5, gap 7d, entity` - what `src/core/metrics/re-derivation.ts` ships today.

| metric | value | 95% interval |
|---|---:|---|
| precision | 6.7% | [1.2%, 29.8%] |
| recall | 0.1% | [0.0%, 72.5%] |
| weighted TP / FP / FN | 1 / 14 / 874 | |

It fires on 15 of the 303 labelled pairs.

## Every GENUINE the judge found

This is the whole positive class. It is small enough to read, and reading it is
the point: a threshold recommendation derived from these without checking them
would be an artifact of a handful of judge calls.

| stratum | J' | cosine | gap | subagent sides | earlier | later |
|---|---:|---:|---:|---:|---|---|
| A3 | 0.05 | 0.74 | 64d | 0 | 2026-05-11 Resolving Hermes WebUI connectivity and MCP tool access | 2026-07-13 NxtSites property integrations and MCP configuration |
| A1 | 0.41 | 0.89 | 28d | 2 | 2026-05-27 Vitest setup and banned-adjective guardrail implementation | 2026-06-24 Implementing Vitest and resource search helpers |
| A2 | 0.21 | 0.92 | 28d | 2 | 2026-05-27 Vitest setup and banned-adjective guardrail implementation | 2026-06-24 Code review of Task 1 implementation |
| P1 | 0.38 | 0.96 | 0d | 2 | 2026-06-21 Implementing per-chunk classify timeout and shared util | 2026-06-21 Implementing NLM memory task 1 |
| A1 | 0.40 | 0.88 | 15d | 2 | 2026-07-08 Code review of NocoDB ledger client | 2026-07-23 Task 3 implementation review and approval |
| P1 | 0.66 | 1.00 | 0d | 0 | 2026-05-11 Creating a Systems Engineer Hermes profile | 2026-05-11 Creation of a Systems Engineer Hermes profile |

## Recommended operating points

Two different numbers, per open question 3 of the parent spec. The counting
threshold feeds the metric; the firing threshold gates an interrupt, where a
false positive costs operator attention rather than a rounding error.

| purpose | configuration | precision | recall | F1 |
|---|---|---:|---:|---:|
| counting (best F1) | `rawPooled >= 0.1, gap 30d, entity, no-subagent` | 19.8% | 81.9% | 0.319 |

## Pareto front

62 of 9122 firing configurations are undominated on both precision and recall.

| configuration | precision | recall | F1 |
|---|---:|---:|---:|
| `rawPooled >= 0.1, gap 30d, entity, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, gap 30d, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 5, gap 30d, entity, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 5, gap 30d, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 10, gap 30d, entity, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 10, gap 30d, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 20, gap 30d, entity, no-subagent` | 19.8% | 81.9% | 0.319 |
| `rawPooled >= 0.1, minTok 20, gap 30d, no-subagent` | 19.8% | 81.9% | 0.319 |
| `strippedPooled >= 0.35, minTok 10, gap 0d, entity` | 65.3% | 15.9% | 0.255 |
| `strippedPooled >= 0.35, minTok 10, gap 0d` | 65.3% | 15.9% | 0.255 |
| `strippedPooled >= 0.35, minTok 5, gap 0d, entity` | 62.5% | 16.0% | 0.254 |
| `strippedPooled >= 0.35, minTok 5, gap 0d` | 62.5% | 16.0% | 0.254 |
| `strippedPooled >= 0.2, minTok 10, gap 0d, entity` | 25.7% | 18.0% | 0.212 |
| `strippedPooled >= 0.2, minTok 10, gap 0d` | 25.7% | 18.0% | 0.212 |
| `rawPooled >= 0.1, minTok 20, gap 0d, entity, no-subagent` | 11.6% | 89.8% | 0.205 |

## Limitations, declared before the numbers are read

1. **The labels are unchecked.** 6 positives carry the entire result. See spot-check.md.
2. **Recall is conditional on this frame.** 3,993,847 zero-entity pairs were never sampled and are not represented in any denominator here.
3. **A1 is 53 pairs.** The incumbent's precision interval is wide no matter what, because that is how few pairs it fires on.
4. **Weighted estimates are fragile at this base rate.** A single label in A4 or A5 moves the population estimate by thousands, which is why the intervals use a Kish effective sample size rather than raw n.
5. **The judge over-calls GENUINE on recurring work.** Two rubric passes removed standing-policy compliance and scheduled reviews; same-day near-identical sessions are still occasionally called GENUINE rather than DUPLICATE.

