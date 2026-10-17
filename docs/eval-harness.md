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
  Fact keyword queries now rank full-corpus lexical candidates before applying
  the candidate bound; older baselines used a recency window. See
  [context retrieval](context-retrieval.md) for the paired candidate experiment.
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

## 6. Source-grounded compact-context control (T806)

The compact-context evaluator is separate from citation/topic goldens above.
Those goldens cannot establish answer sufficiency. A private manifest pins a
snapshot SHA-256, source-family split and case-file SHA-256, reader/tokenizer/
prompt revisions, environment and proposed thresholds. Each typed case records
required literal claims, all alternatives and minimum UTF-16 source ranges.
The source annotator checks complete original bodies before inspecting arm
results; a separate reader receives only the question and returned bundle.

```bash
npx tsx scripts/eval/memory-context.ts \
  --manifest "$HOME/.nlm/eval/memory-context/<run>/manifest.json" \
  --baseline e391597 --candidate <commit> \
  --out "$HOME/.nlm/eval/memory-context/<run>/control.json"
```

Both revisions are resolved to immutable commits and run in separate detached,
executor-owned worktrees under `~/.nxtos/worktrees/`. Each gets a disposable
snapshot clone, private HOME/XDG/runtime/state roots and private query logs.
Cleanup reaps workers and removes their worktrees. The production compact handler and recall services come from each
pinned arm, even when comparing a baseline with itself. No production store is
opened. This path does not run the broad harness's re-derivation scan.

This initial CLI runs **keyword controls only**, with no expansions or model
calls. Unexpected model attempts are recorded as failed calls with unknown
usage, including when retrieval catches their exception. Semantic quality and
live embedding latency remain unavailable until an explicitly configured,
probed adapter and vector conditions are pinned. Do not interpret this control
as the compact tool's default hybrid behavior.

The built-in `literal-bundle-reader@1` is an extractive evidence-containment
diagnostic. It copies returned values, summaries and attributed source quotes/
passages. Required claims and alternatives use case-sensitive literal checks;
every labelled range must appear in evidence attributed to its source ID. A
value without its rationale/range fails; an unanswerable case requires explicit
abstention with no evidence. This reader is not independent semantic
answer-quality proof. Blinded answer review and audits of all disagreements,
no-answer errors and a seeded 10% of agreements remain prerequisites to
promotion. Source-derived template proposals are not an audited natural-query
benchmark merely because their quotations match a source body.

Only development cases run. The initial 120-row private proposal has a 72/48
family-disjoint split and six categories; its source audit status stays pending
until reviewed. Holdout outcomes remain sealed through Tasks 1–9. Source
families must include workstream, ancestry and copied/replayed conversations;
exact/prefix copy grouping alone cannot prove paraphrased-family disjointness.
The frozen adversarial matrix identifies existing checks and required later
scope, conflict, eligibility, cancellation, Unicode and delta tests. Unfinished
matrix rows are limitations, not passes.

Every attempted stage emits a started ledger entry before execution, updated
with result or failure. The report retains request/response text, stage timing
and explicit nullable provider usage fields for failed calls. A programmatic
`EvalDeps` can supply an actual consumer `TokenCounter` with pinned immutable
revision metadata. This CLI currently reports actual tokens as **null** because
no pinned consumer tokenizer is installed; it never estimates them from
characters. Character diagnostics are separate. Synthetic tests use a labelled
character counter solely to verify deterministic accounting, never to claim
model-token measurements. Cost accounting includes schema/instructions,
requests/responses, reader input/output and identical initial caller context;
expansion/model adapters must emit their own complete call ledger if added.
Unknown or incomplete stage costs keep totals null. Reports separate
incremental chain tokens from total tokens and show tokens per supported
answerable case. Abstention successes are excluded from this efficiency denominator.

Paired execution alternates arm order. Confidence intervals resample entire
source families; one family has unavailable bounds even with ten duplicate
questions. Category totals, answerable coverage and no-answer success include
failures. Predicted-abstention precision separately counts correct abstentions
over all predicted abstentions, including false abstentions on answerable cases. Current latency is diagnostic (no performance promotion claim):
>=30 paired workload requests, five warmups, cache/load conditions and separate
SQL segment measurements are still required for the latency gate. No
optimization is promoted by this evaluator: `promotion.eligible` remains false
until the registered Task 10 holdout family and its required evidence exist.
Reports are private, created exclusively rather than overwritten.
