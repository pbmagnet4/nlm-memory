# Caller-declared evidence deltas: inconclusive / no-go

Task T806, Task 8, 2026-10-16. Do not add or register a delta candidate on
this evidence. The required >=20% reduction in total retrieval-chain tokens
and no observed quality decline cannot be established. This is a measurement
stop, not a measured finding that deltas save less than 20%.

The [binding spec](superpowers/specs/2026-10-16-memory-retrieval-improvements.md)
(section 4, Experiments; section 5, Metrics and decisions) permits this API
only after repeated-context replay meets the efficiency gate. Its conditional
gate takes precedence over the implementation file list. No API, reference
helper, seen state, cache, schema change, evaluator feature or runtime overhead
was introduced. Existing compact responses remain unchanged. No optional arm
is development-qualified; held-out evaluation remains Task 10's responsibility.

## Capability audit

Source audited at `c8f99422eaca0f7528482206155a629615cf35ea`; runtime sources
are unchanged from `ed58dc5d2162664ec00e45dbb4ca7b4a4a8030d8`.

- The [evaluation CLI](../scripts/eval/memory-context.ts) rejects a non-null
  tokenizer manifest and supplies `tokenizer: null`. The programmatic
  [TokenCounter interface](../src/core/eval/context/types.ts) is an injection
  point, not an installed, revision-pinned consumer counter. Local Python
  `tiktoken`, `transformers` and `tokenizers` probes were unavailable; the JS
  transformers dependency does not establish an actual consumer tokenizer.
- The CLI reader is `literal-bundle-reader@1`: an extractive diagnostic that
  emits `usage: null`. Its strings are available to the
  [accounting seam](../src/core/eval/context/run.ts), but exact reader I/O
  tokens and billed/cached usage are unavailable. It cannot establish blinded
  semantic answer quality or the no-quality-decline gate.
- [Hook `estTokens`](../src/hook/prompt-recall-hook.ts) is
  `Math.ceil(block.length / 4)`, a character estimate. It is excluded from
  actual token measurement.

Actual baseline/candidate incremental and total chain tokens, tokens per
supported answer, saving ratio and blinded quality delta are all **null /
unavailable**, not zero. No end-to-end delta replay or net saving was measured.

## Frozen trace audit

Read-only snapshot: `2026-10-15/canonical.sqlite`, SHA-256
`08a6b4f2493ca4128b3c7ae0dac590c4d1ed1b7ba2bd0be9044859be4fbb05c7`.
Its hash matched before and after the audit. The database was queried only for
trace-table schema; no migration or source-body read occurred. The audit used
all records in the snapshot's three frozen sidecars, with no time filtering,
joining or deduplication. There were zero invalid JSON object lines.

| Frozen log | Objects | Non-placeholder conversation labels | Unattributed/placeholder | Recorded workstream or resolved scope |
| --- | ---: | ---: | ---: | ---: |
| `query_log.jsonl` | 40,608 | 4,523 | 36,085 | 0 |
| `fact_query_log.jsonl` | 27,574 | 82 | 27,492 | 0 |
| `hook-log.jsonl` | 47,019 | 42,989 | 4,030 | 0 |

These are mixed historical telemetry populations, including tests/evaluations;
counts are not an operator-only or development-qualified conversation sample.
The hook log contains 11,223 recall entries; other entries include lifecycle
and citation events. Neither event counts nor returned IDs prove reusable
rendered evidence.

The [session](../src/core/recall/query-log.ts) and
[fact](../src/core/recall-facts/fact-query-log.ts) log schemas record pull
selectors/returned IDs, not complete responses, resolved authorization/scope,
rendering policy, reference versions or downstream reader/refetch costs.
Historical conversation-label attribution provenance is not recorded. Hook
`promptPreview` is not the full query. Missing scope is unknown: the current
writer's optional workstream field cannot retroactively establish historical
all-accessible scope. No conversation, scope or full query was inferred from
filesystem paths, timestamps, previews, IDs or adjacent events.

There are **zero traces with the complete required recorded identity**; the
actual repeated-context rate remains **unknown**, not zero. No repeat groups
or token-saving upper bound were derived. Development question/vector counts
are not repeated-conversation traces. No synthetic trace was replayed as
observed usage. Held-out questions, labels and outcomes were not opened.

## Reopening criteria

First obtain provenance-backed development conversations with authenticated
tenant, explicit conversation/reset boundaries, full query/selectors, resolved
scope and intent, packing/policy revision, complete rendered evidence and
current eligibility. Pin an actual consumer tokenizer/model revision and an
independent reader; record initial context, actual tool schema/instructions,
all requests/responses, references/unavailable entries, expansion/refetch and
reader I/O, plus separate embedding and cached/billed usage, including failures.
Measure paired total and incremental costs across all requests and supported
answers. Smaller response text or repeated IDs alone cannot qualify.

Only reopen implementation if this development evidence supports >=20% fewer
total chain tokens without observed quality decline. References must bind the
full rendering identity, including confidence/decision state even when body
text is unchanged; source-body versions alone are insufficient. Recompute
eligibility on every call, keep tenant authority in authenticated transport,
validate at most 64 caller references and use no server-global conversation
cache. Then require independent-reader/refetch replay and all source/query/
packing/scope/policy/confidence/decision-state invalidations, compaction reset,
retirement/rebinding and indistinguishable foreign/nonexistent-reference tests.
Those delta tests were **not implemented or run** here; no pass is claimed.
Keep any later candidate disabled until development qualifies it, and retain
Task 10's sealed, preregistered held-out promotion gate.
