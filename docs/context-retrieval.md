# Compact memory retrieval

`recall_context` is the first call for a memory question. It combines existing
structured facts with decisions, unresolved questions, and original source
passages. It performs selection, not answer generation. No classifier or
decision-model request is added to the retrieval path.

```json
{"query":"Why did we choose SQLite?","intent":"decision","maxChars":8000}
```

For exact values, pass normalized `subject` and `predicate`. A lookup with one
matching fact skips session search and embeddings. Otherwise the fact lane uses
hybrid retrieval and the session lane uses keyword retrieval by default. These
preserve the existing measured lane policies; `mode` overrides both. `intent`
accepts `auto`, `lookup`, `decision`, `state`, and `history`. History includes
superseded sessions; other intents exclude them. An unavailable embedding lane
is reported with `modeUnavailable`, rather than presented as full hybrid recall.

## Evidence contract

- Facts retain their kind, subject, predicate, value, source IDs, extraction
  confidence and source quote. Confidence is the classifier's extraction
  confidence, not a calibrated probability of truth or query relevance.
- Identical triples are deduplicated with their retrieved source IDs preserved.
  Different values survive; `multipleValues` flags alternatives in the candidate
  set without asserting that multi-valued attributes are contradictions.
- `quoteVerified` is true/false only when a source body was fetched and checked;
  null means not verified. A classifier-supplied quote is not automatically
  treated as an exact transcript excerpt.
- Session passages are exact slices of the stored body with UTF-16 `offset` and
  `end` positions. Semantic search retains its winning `chunkIndex` for locating
  relevant evidence when semantic/hybrid mode is explicitly selected.
- Source status and successor IDs travel with facts, so a current fact sourced
  from an overturned session is visibly qualified. Structured project/service
  registries remain authoritative for current operational values.
- A response fits whole evidence records, preserves expansion IDs, and reports
  omitted candidate counts. Those counts are not exhaustive corpus totals.

`maxChars` bounds serialized response characters (default 8000, range 2000 to
20000), not model tokens. The budget reserves space for sources and tool
metadata. Long queries are not echoed repeatedly. Facts share the budget with
session context so a list of triples does not crowd out rationale.

## Targeted expansion

`get_session({id, query})` returns summary, relevant decisions/open questions,
current facts, supersedence/outcome information, and matching original passages.
An ID-only call returns compact context; it no longer returns a full body.
The tool's default budget and allowed range match `recall_context`.

```json
{"id":"<source-session-id>","view":"transcript","offset":0,"maxChars":8000}
```

Transcript mode returns `body` and a `next` argument object. Follow `next`
unchanged until null. Pages fit the serialized budget without clipping their
body, preserve surrogate pairs, and include a version to detect a transcript
that changed between calls. Offsets address the stored body, which may itself
be capped by ingestion. Pagination cannot recover text ingestion never stored.

The shared response guard also preserves partial records for oversized legacy
search/history responses instead of replacing the entire payload with a notice.
It labels shortened output explicitly. Use targeted expansion for complete text.

## Fact candidate coverage

SQLite migration 042 adds a maintained FTS5 index on fact subject/predicate/value.
Postgres migration 038 adds the equivalent GIN text-search index. Text queries
rank matching candidates across the full tenant-filtered corpus before applying
the 500-candidate bound. The service retains its existing final scorer. Queries
without text retain bounded structured filtering. Supersedence, retirement,
confidence and tenant predicates apply before the SQL limit.

The backends use their native tokenizers, so punctuation tokenization and lexical
ranking can differ. Both pass the shared contract for old facts, safe query
syntax, and structured filtering. No stored facts are rewritten or retired.

## Evaluation

Run the normal typecheck, build and full test suite. The integration gate covers
old facts, mid-transcript evidence, conflicting values, tenant fencing and
lossless transcript expansion. Both store adapters run the shared fact contract.

```sh
npx tsx scripts/eval/context-retrieval.ts <frozen-snapshot> <private-report.json> keyword hybrid
```

This compares the former recency-window candidates against full-corpus lexical
candidates on separately migrated disposable snapshot clones. Both arms share
query embeddings. The runner fails on fact R@1 regression. Its topic goldens are
synthetic subject/predicate queries, and citation goldens measure use rather than
independently verified answer correctness. Cached-embedding arm runtimes are not
latency comparisons. Private reports stay outside git.

Classifier extraction is reused at ingestion. Decision-model reranking or richer
rationale extraction should be evaluated separately against independently judged
questions, including total model tokens, follow-up retrieval calls and latency.
They are not enabled based on smaller output or model availability alone.
