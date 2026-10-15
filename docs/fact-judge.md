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
