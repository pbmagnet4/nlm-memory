# Evaluating recall quality

Three surfaces keep recall quality honest: a per-commit CI gate that fails on
regressions, an ad-hoc `nlm eval` readout an operator runs against their own
query set, and a weekly scheduled measurement that records trend over time.

## 1. CI regression gates (every commit)

Two tolerant gates run as part of `npm test` and must stay green:

- **Session lane** — `tests/integration/recall-golden.test.ts` asserts each
  golden query surfaces its expected session in the keyword top 3 over a fixed
  synthetic corpus.
- **Fact lane** — `tests/integration/fact-recall-gate.test.ts` runs `runEval`
  over a small synthetic fact corpus in keyword mode and asserts R@5 stays at or
  above a conservative floor (0.8). The floor is set from the first green run, so
  a real regression fails CI while ordinary scoring noise does not.

Both corpora are invented and committed. Neither touches the embedder, so they
run with no Ollama dependency.

## 2. `nlm eval` (ad-hoc, operator query set)

`nlm eval --queries <file> [--mode keyword|semantic|hybrid] [--json]` runs
R@1 / R@5 / MRR over an operator-supplied JSON query set against the live store:

```json
[
  { "query": "which vector store did we pick", "expectedIds": ["<session-or-fact-id>"] }
]
```

The query file is operator-supplied and never bundled in the repo (it can name
private projects). Default mode is `keyword`; pass `--json` for machine-readable
output (`mode`, `n`, `rAt1`, `rAt5`, `mrr`, and per-query `misses`).

The shared runner is `src/core/eval/run-eval.ts` — the same code the fact-recall
gate uses, so the CI floor and the ad-hoc readout measure the metric identically.

## 3. Weekly scheduled measurement

Not auto-installed (mirrors how `docs/backups.md` documents rotation rather than
wiring a daemon). On a weekly cadence, run both arms and write JSON to a
`reports/` directory the operator keeps out of the repo:

```bash
npm run bench:longmemeval -- --limit 500   # session R@k over the LongMemEval-S set
npm run eval:fact-recall                    # fact R@k/precision over a sandbox corpus copy
```

`eval:fact-recall` (`scripts/eval/fact-recall-eval.ts`) opens a throwaway copy
of the canonical store, so the live daemon DB is never touched. Capture the JSON
output per run and diff R@5 / MRR week over week; a sustained drop is the signal
to investigate, not a single noisy run.
