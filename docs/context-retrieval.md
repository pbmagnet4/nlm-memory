# Compact memory retrieval

`recall_context` is the first call for a memory question. It combines existing
structured facts with decisions, unresolved questions, and original source
passages. It performs selection, not answer generation. No classifier or
decision-model request is added to the retrieval path.

```json
{"query":"Why did we choose SQLite?","intent":"decision","maxChars":8000}
```

For exact values, pass normalized `subject` and `predicate`. A lookup whose complete SQL probe finds exactly one
distinct eligible value skips session search and embeddings. Exact fact filters use
keyword retrieval. Broad lookup uses hybrid retrieval for facts and the session lane uses keyword retrieval by default. These
preserve the existing measured lane policies; `mode` overrides both. `intent`
accepts `auto`, `lookup`, `decision`, `state`, and `history`. History includes
superseded sessions; other intents exclude them. An unavailable embedding lane
is reported in `coverage`, with `modeUnavailable` also included when space allows.

## Request budget and partial coverage

`timeoutMs` defaults to 1500 milliseconds and accepts 100–5000. The core request
budget includes scope resolution, the complete exact-value probe, independent
fact/session lanes, and source hydration. Non-exact lanes run concurrently.
Explicit hybrid-both requests share one lazy embedding only for identical query
text, embedding kind, and client identity, within that request. Existing session
and hook embedding caps compose with the remaining request budget.

`coverage` reports `facts` and `sessions` as `complete`, `partial`, or
`unavailable`, with machine-readable `reasons`. Complete means that lane finished
its bounded retrieval contract; it does not assert corpus-wide recall. An exact
unique probe can fulfill that contract without launching the session lane.
`lookup.complete` separately reports exact-value probe completeness. Semantic
failure or a deadline preserves lexical evidence already prepared by each lane;
a late result cannot change the returned response.

File-backed SQLite context semantic reads run in a pool capped at two read-only
workers and eight queued reads, using the same exact eligibility/top-k SQL as the
cooperative direct adapter. These workers run no migrations or writes. Abort
settles the caller and requests worker termination; native SQLite may continue
until it returns from C++, so its slot remains occupied until actual worker exit.
Storage shutdown waits for all workers. Other main-thread SQLite reads and direct
adapter callers remain cooperative: timers cannot preempt synchronous SQL. The
1500 ms default is a service budget, not a demonstrated end-to-end SLO.

MCP calls never scan ambient transcript directories for attribution. Logs use a
trusted transport context only when its tenant matches the authenticated tenant;
otherwise recall still records the query and returned IDs without a consumer
conversation ID. Citations retain their explicit `conversation_id`, trusted
context, and tenant-bound hook memo paths; an unattributable citation reports
`logged:false`. There is no background transcript crawl. Existing transports that
provide no trusted conversation context therefore lose heuristic attribution.

## Evidence contract

- Facts retain their kind, subject, predicate, value, source IDs, extraction
  confidence and source quote. Confidence is the classifier's extraction
  confidence, not a calibrated probability of truth or query relevance.
- Identical triples are deduplicated with their retrieved source IDs preserved.
  Different values survive; `multipleValues` flags alternatives in the candidate
  set without asserting that multi-valued attributes are contradictions.
- `quoteVerified` is true when a current version-matched unique literal anchor
  or fresh bounded source check verifies the quote. False/null do not establish
  verification. A classifier-supplied quote is not automatically an exact excerpt.
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
metadata. When new coverage metadata would displace a record, optional display
fields may be removed whole to compensate for its measured serialized overhead;
mandatory scope, lookup and per-record expansion selectors stay exact. Long queries
are not echoed repeatedly. Facts share the budget with
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
syntax, and structured filtering. No stored facts are rewritten or retired. Both migrations also add a covering
index for the corroboration join on tenant/subject/predicate/value/source session;
without it, each candidate count scans every fact in the tenant.

## Evaluation

Run the normal typecheck, build and full test suite. The integration gate covers
old facts, mid-transcript evidence, conflicting values, tenant fencing and
lossless transcript expansion. Both store adapters run the shared fact contract.

```sh
npx tsx scripts/eval/context-retrieval.ts <frozen-snapshot> <private-report.json> keyword hybrid
```

This compares the former recency-window candidates against full-corpus lexical
candidates on one migrated disposable snapshot clone. Both arms share
query embeddings. The runner fails on fact R@1 regression. Its topic goldens are
synthetic subject/predicate queries, and citation goldens measure use rather than
independently verified answer correctness. Cached-embedding arm runtimes are not
latency comparisons. Private reports stay outside git.

Classifier extraction is reused at ingestion. Decision-model reranking or richer
rationale extraction should be evaluated separately against independently judged
questions, including total model tokens, follow-up retrieval calls and latency.
They are not enabled based on smaller output or model availability alone.

The report also compares raw session serialization with compact `get_session`
responses for the held-out citation queries (one source per query, deduplicated).
This measures response characters and budget compliance, not model token counts
or whether the selected passages completely answer each question.

## Measured on the 2026-10-15 frozen corpus

Paired candidate experiment, 2026-10-16; both arms use the same query embeddings
and migrated clone. No fact R@1 regression in either split or tested mode.

| Held-out synthetic fact-topic queries (122) | Previous candidates | Full-corpus candidates |
| --- | ---: | ---: |
| Keyword R@1 | 0% | 36.9% |
| Keyword R@5 | 0% | 39.3% |
| Hybrid R@1 | 73.0% | 73.0% |
| Hybrid R@5 | 100% | 100% |

The keyword improvement removes an age blind spot; its remaining errors mean
keyword alone is not an adequate default for unstructured fact questions.
Hybrid remains the fact default. These synthetic labels do not establish answer
correctness on natural-language questions.

On 26 deduplicated held-out source sessions, raw serialization totalled 3,344,708
characters and compact session context 120,591 (96.4% fewer characters). Twenty
raw sessions exceeded 25,000 characters; compact responses had zero errors and
zero budget violations. Expansion is required for full transcripts. Character
reduction is not a measured model-token reduction or proof of context sufficiency.

A 12-triple corroboration batch on a disposable corpus clone returned identical
counts over 10 alternating runs. Median was 93.38 ms using the former tenant-only
index and 0.044 ms using the covering index; SQLite also selects the new index
without an index hint. This isolates that SQL lookup, not whole-request latency.

Independent Muse review of the implementation found one low-severity telemetry
defect: exact fact lookups logged a phantom session search. Accepted and fixed;
regression coverage verifies the fact event without a session event. Later
semantic-only, short-identifier and covering-index refinements were verified
against source excerpts and the shared storage/integration gates.

## Retrieval improvements (T806)

The [measurable retrieval specification](superpowers/specs/2026-10-16-memory-retrieval-improvements.md)
and [SDD implementation plan](superpowers/plans/2026-10-16-memory-retrieval-improvements.md)
define the implemented required correctness work and the measured optional experiments.
See [integration results](memory-retrieval-results.md) for the final evidence, limitations,
review state and pending deployment. Numeric acceptance thresholds remain targets;
optional ranking, delta responses and model reranking did not qualify.

## Workstream scope

Pass `workstream` (an ID or label) to restrict `recall_context`, `recall_sessions`,
`recall_facts`, `get_session`, or `get_fact_history`. Resolution uses the authenticated
tenant and follows tenant-owned merge chains. Omit it to search all accessible
workstreams. Unknown IDs, foreign IDs, corrupt merge chains, and unavailable scope
resolution return no scoped evidence; they never fall back to an unrestricted search.
`recall_context` reports resolution once in `scope`.

Expansion arguments preserve the requested selector. Use those arguments unchanged:
`get_session` transcript pages and scoped fact history recheck current session bindings,
so a session moved to another workstream becomes unavailable on the next expansion.
Facts inherit retrieval eligibility from their source session's current binding.
Keyword and semantic eligibility apply before the final candidate limit in both adapters.
SQLite semantic retrieval uses direct eligible exact distance for explicit scopes; its
unscoped adaptive native search expands until a completeness witness proves the exact
eligible top-k, otherwise it falls back to an eligible full scan. An older fixed global
window cannot silently starve scoped results.


## Complete lookups

An explicit subject/predicate lookup reports `lookup.distinctValueCount` and
`lookup.complete` from one full current-value SQL aggregate, independent of the
12-result or 500-candidate windows. Retired, superseded and ineligible rows do not
count. Only a complete single-value result permits the fast path. Multiple values
remain visible with a scoped history expansion; errors never prove uniqueness.

Explicitly scoped optional related-fact/concept/exemplar enrichments are suppressed
until their pickers enforce source membership; scoped primary facts remain available.

## Source versions and literal anchors

SQLite migration 043 and PostgreSQL migration 039 add nullable source offsets,
quote status and body versions. Ingestion locates a unique literal occurrence in
the exact persisted body using UTF-16 offsets, including non-BMP characters.
Matching versioned positive and negative assessments avoid loading fact-only source
bodies. Legacy, missing or stale assessments use bounded on-demand verification;
this does not persist a backfill. A quote location establishes neither claim truth
nor operator acceptance. Scoped expansion rechecks membership and source version.

Old binaries or raw SQL body writes that omit a new version invalidate the stored
version through additive guards. Null versions fail closed. No stored fact is
retired or reinterpreted, and no automatic corpus-wide hashing/backfill occurs.
Expansion still reads complete source bodies. Legacy hydration is deduplicated
within each publication only: a hybrid partial and final publication can each read
the same source body. This known I/O limitation remains under final review; isolated
verification CPU measurements exclude it. See the [results](memory-retrieval-results.md).
