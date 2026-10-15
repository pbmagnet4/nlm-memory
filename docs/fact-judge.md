# Write-time fact judge (E3)

Experiment E3 of [the memory experiments plan](plans/2026-10-15-memory-improvement-experiments.md). A model reviews each new fact against up to five similar existing facts. It is off by default and changes nothing in `shadow`.

## Behaviour

`NLM_FACT_JUDGE=off|shadow|on` (default `off`). After a session's facts are committed and embedded, each fact gets up to five candidates: active facts with the same normalized subject and predicate first, then nearest by embedding. The classifier lane (`complete()` on the LLM client, through the shared in-flight limiter; transient errors retry with backoff) answers with strict JSON:

| Action | Meaning | Effect in `on` |
|---|---|---|
| `KEEP_BOTH` | Both can be true, or unsure | none |
| `SKIP_NEW` | New fact restates an existing one | new fact gets `superseded_by` = existing |
| `SUPERSEDE_OLD` | New value for the same attribute | existing fact gets `superseded_by` = new |

Any transport failure, malformed reply, unknown label or missing target becomes `KEEP_BOTH`. No row is deleted or overwritten. `on` applies a batch only if the sweep guard allows it (`NLM_FACT_JUDGE_MAX_SHARE`, default 0.5 of the batch; the guard binds from `NLM_SWEEP_MIN_TARGET` rows) and never uses a fact twice in one batch. Every decision is appended to `fact-judge.jsonl` in the tenant state dir (`NLM_FACT_JUDGE_LOG` overrides), with ids only.

## Offline evaluation

```bash
npm run eval:fact-judge-replay -- <snapshotDir> --out-dir=<dir>    # replay on a clone, serial
npm run eval:harness -- run <dir> --out=<dir>/report.json            # score the clone
npm run eval:harness -- compare <baseline>.json <dir>/report.json
NLM_LABELER_BASE_URL=... NLM_LABELER_MODEL=... npm run eval:fact-judge-label -- <dir>
```

The replay judges every active fact in the conflicting groups plus a seeded random sample from other groups, in creation order, each seeing only older candidates, and applies decisions to the clone. The labeler must be a different model family than the judge and never sees the decision source; see the script header.

## Result: 2026-10-15 snapshot (T734)

Judge: a 12B Gemma-family model on the classifier lane. Labeler: a Qwen-family model on a local lane (different family, sees facts only). Replay: 390 facts (90 in the 44 conflict groups, 300 random from other groups), serial, on a clone; the live store was never opened.

| Measure | Baseline | Judge `on` (clone) |
|---|---|---|
| Conflicting active-fact groups (I5a) | 44 | 19 (-57%) |
| Fact R@1 semantic/hybrid, dev | 64.8% / 64.0% | 64.8% / 64.0% (0.0) |
| Fact R@1 semantic/hybrid, held-out | 64.8% / 63.9% | 65.6% / 64.8% (+0.8 pt, within noise) |
| Fact R@5, all lanes | | unchanged |
| Decisions, conflict arm (90) | | 62 KEEP_BOTH, 28 SUPERSEDE_OLD, 0 SKIP_NEW |
| Decisions, other arm (300) | | 292 KEEP_BOTH, 5 SUPERSEDE_OLD, 3 SKIP_NEW |
| Added latency per fact (retrieval plus model) | | p50 5.9 s, p95 22.3 s, mean 8.1 s |

Blind sample of 100 (36 mutating, 64 KEEP_BOTH): the labeler marked 9 of 36 mutating decisions incorrect (25%; conflict arm 5 of 28, other arm 4 of 9 mutating including 4 of 5 supersessions) and 2 of 64 KEEP_BOTH incorrect. A hand read of all 36 mutating decisions marked 12 incorrect (33%). Typical errors: events or facets treated as replacements (`status` events, a package version vs a dependency version, a requirement vs an installed version). A second-model recheck was not possible (the third local family would not load on the shared server), so the hand read stands in for it.

Verdict: conflicts fall past the 50% target and R@1 does not drop, but false supersession is 25 to 33% against a 2% target and a 5% kill line. Do not enable `on`. Keep it in `shadow`, or tighten the prompt (state versus event facts, E6) and re-measure before any live use. Limits: one judge model, a labeler that is also a model, 36 mutating decisions in the sample, synthetic fact goldens.
