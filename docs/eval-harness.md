# Shared eval harness

One frozen snapshot, one command, one JSON report. Every experiment runs a
baseline and a candidate on the same snapshot on the same day and compares them.
Snapshots, goldens and reports contain real session text and live outside the
repo (`~/.nlm/eval/`). Only code and a synthetic corpus are committed.

## 1. Snapshot

```bash
npm run eval:snapshot            # -> ~/.nlm/eval/snapshots/<date>/
```

Copies the store with SQLite's online backup API (never a raw copy of a live WAL
database) and copies `query_log.jsonl`, `fact_query_log.jsonl`,
`citation-log.jsonl` and `hook-log.jsonl`. Files are mode 0444, the database is
left in rollback-journal mode, and an existing snapshot is never overwritten
(pass `--date=` for a second snapshot on the same day). The live store is only
read.

## 2. Goldens

```bash
npm run eval:harness -- goldens ~/.nlm/eval/snapshots/<date>
```

Writes `goldens.json` next to the snapshot and prints counts. Split: 70% dev,
30% held-out, by a stable hash of the query text. Use dev while iterating and
held-out for final scoring only.

| Set | Label source | Limits |
|---|---|---|
| Session | A query is joined to later citations in the same conversation (citation log plus `citedIds` on hook `stop` records); a session is relevant if the query had returned it | Needs a conversation id on the query, so only part of the traffic qualifies. Relevance is limited to ids the query returned, so it grades ranking of what retrieval found, not what it missed. A citation shows use, not that the session was the best answer. Most logged queries ran in keyword mode, so returned ids favour keyword retrieval and semantic-only recall on this set is understated. Filters (`entity`, `kind`) are ignored. |
| Fact (topic) | Synthetic: the query is a fact's `subject predicate` with the value held out; the fact must be an active decision fact (confidence 0.6 or more) whose (subject, predicate) is unique among active facts | Not usage-derived. Favours facts whose subject and predicate are distinctive. Sampled by id hash (default 400, `--fact-sample`). |
| Fact (citation) | Same join as sessions, for `fact_` ids | Currently empty: facts are almost never cited with a conversation id the fact query log shares. Reported so it shows up when it grows. |

## 3. Run

```bash
npm run eval:harness -- run ~/.nlm/eval/snapshots/<date> --out=<report>.json
# --modes=keyword to skip the embedder
```

The run clones the snapshot to a temp dir (APFS clone, no copy cost) and
migrates the clone, so the snapshot stays byte-identical. Semantic and hybrid
modes probe the embedder first and fail loudly if it is down, rather than
silently degrading to keyword. Metrics in the JSON:

- `retrieval.{session,fact}.{dev,heldout}.<mode>`: `n`, `rAt1`, `rAt5`, `mrr`.
  Fact keyword mode reads only a recency-capped window of facts, so on a large
  store its fact recall is near zero by design; judge fact changes in semantic
  and hybrid.
- `store`: `conflictingActiveFacts` (the doctor I5a query, current exempt
  predicate set), `multiValuedGroups` (I5a-mv, informational),
  `missingEmbeddingShare` (active facts with no row in the `fact_embeddings`
  rowids table, the table the doctor's I7 and the embed backfill key on),
  `dbBytesByTable` (dbstat, indexes and FTS5/vec0 shadow tables rolled up).
- `hookTokens`: `estTokens` per hook call from the hook log; all calls and
  injecting calls separately.
- `classifyLatency`: null. No snapshotted log records classify latency.
- `reDerivation`: `nlm metrics re-derivation` over a 90-day window (anchored at
  run time; sessions are frozen, so same-day runs match).
- `citation`: `perSource` is `nlm precision`'s per-source figure (citation log,
  query log). Sources that never log a conversation id are listed as
  unmeasurable rather than scored 0.

## 4. Compare

```bash
npm run eval:harness -- compare <baseline>.json <candidate>.json
```

Prints every delta. Exits 2 and prints a REGRESSION block if any fact R@1 fell
in any lane or mode (plan rule 4). Baselines live in `~/.nlm/eval/baselines/`.

## 5. Add a metric

1. Add a pure function in `src/core/eval/harness/metrics.ts` that reads the
   sandbox database or a log text.
2. Add the field to `HarnessReport` and `runHarness` in `run.ts`, and a line in
   `formatReport`.
3. If a change should be flagged, add a row in `compare.ts`.
4. Extend `tests/integration/eval-harness.test.ts` (invented corpus only) and
   run `npm test`.

CI covers the code with a synthetic corpus in keyword mode; the CI recall gates
in section 1 of [eval-recall.md](eval-recall.md) are unchanged.
