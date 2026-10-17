# Measurable NLM retrieval improvements

Status: approved for implementation; execution T806 is in progress. Planning work: T805.
Required Tasks 1–6 are implemented and independently reviewed, including additive source anchors and old-writer invalidation.
The 120-question source-audited set is frozen. Ranking development ended inconclusive/no-go; evidence-delta feasibility is in progress and scientific promotion remains pending. The anchor CPU target failed for the actual legacy population; conditional new-write results do not replace it.
Baseline: local main `e391597` (T803 compact retrieval), not the oversized raw-session API.
Owner: nlm-memory. Existing related work: T527 ranking calibration, T679 hook latency;
coordinate capture work T264/T265 without changing their ingestion adapters incidentally.

## 1. Outcome and scope

Improve the agent's ability to obtain sufficient, current, correctly scoped evidence at
lower total token/latency cost. Smaller output alone is not success. Implement correctness
and measurement first; promote optional optimizations only when a paired experiment earns them.

Required: explicit workstream filtering, eligible semantic candidates, complete exact-value
checks, shared retrieval deadlines, verified literal source anchors, and an end-to-end evaluator.
Experiments: corroboration calibration, caller-declared evidence deltas, selective decision-model
reranking. Persistent embedding caches and richer decision schemas require evidence from these
experiments; they are not prerequisite infrastructure.

No automatic retirement/reinterpretation of facts, predicate-class ingest changes, vector-store
replacement, transcript deletion, fleet-wide backfill, or public release is authorized by this plan.
Implementation and deployment are separate steps. Verify the installed version before rollout:
T803 was landed locally and was not deployed in the preceding implementation session.

## 2. Verified starting point

| Mechanism | Source at baseline | Consequence |
| --- | --- | --- |
| Compact context routes hybrid facts, keyword sessions; serial searches; exact checks inspect at most 12 fact hits | `src/mcp/server.ts:contextInput`, `recallContextHandler` | Missing workstream input, incomplete ambiguity proof, avoidable serial latency |
| Existing session search accepts workstream labels; resolver reads DEFAULT_TEAM_ID | `src/cli/nlm.ts:buildStack`, `src/core/recall/recall-service.ts:search` | Reuse membership logic after making tenant explicit; do not copy the default-tenant closure |
| Fact eligibility has no workstream field | `src/ports/fact-store.ts:FactListFilter` | Both lexical and semantic fact lanes need source-session membership filtering |
| SQLite KNN overfetches globally before tenant/workstream/lifecycle filtering | `sqlite-session-store.ts:semanticSearch`, `sqlite-fact-store.ts:semanticSearch` | Valid results can lie beyond the fixed global candidate window |
| Fact embeddings call the provider without a recall-level signal/deadline; session embedding already has a deadline | `fact-recall-service.ts:runSemantic`, `recall-service.ts:search` | A shared request budget must compose with existing hook budgets |
| Fact quotes are optional classifier strings; confidence is session-level | `src/core/facts/extract-facts.ts`, `src/ports/llm-client.ts` | Literal verification and semantic truth must remain separate |
| Character limits and synthetic/citation metrics exist | `docs/context-retrieval.md`, `src/core/eval/harness/*` | Reuse snapshot/splits/scoring; add token and evidence-sufficiency measurements |
| Synchronous SQLite can block the event loop | storage adapters; prior dataset-stall work | AbortSignal alone cannot promise a hard wall-clock bound |

Read the named symbols, rather than relying on these line numbers, at execution preflight.
A disposable in-memory probe using the installed sqlite-vec and the same auxiliary-column
shape successfully ran `vec_distance_L2(embedding, ?) WHERE session_id IN (?) ORDER BY distance`.
This establishes API availability, not performance on the real corpus.

Existing T803 measurements: 122 held-out synthetic fact queries, hybrid R@1 73.0%, R@5 100%;
26 held-out source sessions used 96.4% fewer characters than raw serialization. These are
historical diagnostics, not independent answer-quality baselines or new improvement claims.
The covering corroboration index already exists; do not implement or claim its gain again.

## 3. Binding contracts

1. Tenant comes from the authenticated transport, never tool input. Every new read and join
   uses that tenant, including membership resolution, evidence expansion and telemetry.
2. Add one public relevance selector, `workstream?: string`, using existing ID/normalized-label
   resolution and merge chains. Unspecified means all accessible workstreams; an explicit
   unknown/foreign value returns the same empty-scope result, never an unscoped fallback.
   Workstream selection is a relevance filter, not a replacement authorization system.
3. Apply source-session membership, retirement, supersedence, confidence, kind and explicit
   subject/predicate constraints before top-k. A shortage after filtering must not be called
   exhaustive unless the eligible search was actually exhaustive.
4. Exact subject/predicate lookups inspect every eligible current distinct value in SQL before
   their fast path. Two preview values are sufficient if the complete distinct count is returned.
   Multiple values are not automatically contradictions: event/facet semantics are unchanged.
5. Return complete evidence records within the existing 2,000–20,000 character transport guard.
   Token metrics use a pinned tokenizer and are labelled unavailable when exact counting is
   unsupported. Never label character estimates as model-token measurements.
6. No new query-time generative calls in the required path. Ingestion reuses the classifier's
   existing output. Any model experiment uses configured LiteLLM role slots, pinned at run time;
   provider/model/revision/prompt and all usage are recorded. No silent provider switching.
7. A literal anchor verifies a quote's location, not the claim's truth or the user's acceptance.
   Missing, repeated, stale and invalid quotes remain explicitly unverified; preserve their facts.
8. Every source write, including scheduler, webhook, reprocess and test seed paths, updates the
   version derived from the exact persisted body. Offsets are UTF-16 into that body, after its
   normalization/cap. Never compute offsets into the uncapped classifier input or raw file.
9. Deadline/cancellation is cooperative in the main-thread SQLite adapter. Return available
   lanes with explicit partial/timeout metadata. SQL time is measured separately; no promise of
   hard preemption or responsiveness from racing a synchronous query against a timer.
10. Schema additions are nullable, additive and implemented in SQLite and Postgres. Resolve the
    next unused migration versions at execution; do not edit migrations 042/PG038 already landed.
11. Deterministic gates, accepted review findings, source-grounded experiments and rollout evidence
    are required. A low-powered, unavailable or failed measurement is inconclusive, never a pass.

## 4. Interfaces and behavior

### Scope and semantic eligibility

Create `src/core/recall/resolve-scope.ts`:
`resolveRecallScope(store: WorkstreamStore, tenantId: string, idOrLabel?: string): Promise<ResolvedRecallScope>`.
`ResolvedRecallScope = {status:'all'; workstreamIds?:undefined} |
{status:'resolved'; workstreamIds:readonly [string, ...string[]]} |
{status:'not_found'; workstreamIds:readonly []}`.
`all` omits IDs, `resolved` carries nonempty IDs, `not_found` carries an empty array.
The function resolves only tenant-owned nodes; cyclic/corrupt merge chains fail closed for an
explicit selector. It never infers scope from a filesystem prefix or invents a project registry.

Extend the existing RecallService resolver callback to take `(tenantId, idOrLabel)`. Add an
optional third `RecallExecutionOptions` argument to both recall service `search` methods;
initial fields are `workstreamIds?: readonly string[]`, later signal/deadline/embedding fields.
An explicit empty array means no eligible records. Preserve two-argument callers. Legacy
`RecallQuery.workstream` resolution uses the same tenant-aware helper; reject inconsistent
simultaneously supplied scope constraints internally instead of broadening them.

Factor `FactEligibility` out of FactListFilter (subject, predicate, kind, confidence,
includeSuperseded, workstreamIds). `FactListFilter` adds query/limit. Fact semanticSearch takes
optional FactEligibility; session SearchOptions already carries workstreamIds.
SQLite uses an eligible exact-distance query with tenant/metadata joins before the final limit;
retain the best chunk per eligible session. Avoid depending on the historically incomplete
chunk map as the sole eligibility source. Postgres applies the same joins/filters before limit.
Benchmark native SQL variants on the frozen corpus; a new approximate fast path must expose
its incomplete coverage and pass the oracle comparison before use.

Scope metadata appears once per context response. Expansion arguments carry the requested
workstream selector; `get_session` and scoped fact-history expansion recheck current membership
within the tenant before revealing content. Rebinding between calls must not reuse stale scope.

### Complete current-value probe

Add `FactStore.summarizeCurrentValues(tenantId, query: CurrentValueQuery): Promise<CurrentValueSummary>`.
`CurrentValueQuery = Omit<FactEligibility, 'includeSuperseded'> &
{subject:string; predicate:string}`; the implementation always excludes historical superseded rows. `CurrentValueSummary = {distinctValueCount:number; sourceSessionCount:number;
examples: readonly {value:string; sourceSessionId:string}[]}` with at most two complete examples.
One consistent SQL statement/snapshot computes counts and previews using the same eligibility.
Retired/superseded/wrong-tenant/wrong-workstream rows never count. No candidate-window LIMIT
may precede the distinct aggregate. Examples are ordered deterministically.

The tool emits `lookup:{distinctValueCount, complete}` for explicit lookups. Fast path requires
`complete=true && distinctValueCount===1`. A timeout/error never proves uniqueness. Preserve
multiple values, identify omitted alternatives, and provide a scoped history expansion.
General search's `multipleValues` remains a candidate-set observation unless a full probe ran.

### Request execution

Add `signal?:AbortSignal`, `deadlineAt?:number` and request-local `queryEmbedding?:Promise<EmbedResult>`
to RecallExecutionOptions. Time values use one injected monotonic clock, in milliseconds.
Default compact-context budget is 1,500 ms; optional timeoutMs range 100–5,000. This is a proposed
service budget, not a measured current SLO. Existing hook callers retain their tighter/equal caps.
Propagate the minimum remaining budget; an already-aborted signal launches no outbound work.

Decision/state/history requests run independent fact/session lanes concurrently. Explicit exact
lookups probe uniqueness first and avoid session search when safe. If both lanes require the
same exact query embedding, share one request-local promise keyed by query text/kind and the
same embedder identity; different queries/models do not share. Global caches are out of scope.
Stop timers/listeners in finally; model failures do not erase successful lexical evidence.

Response metadata: `coverage:{facts:'complete'|'partial'|'unavailable';
sessions:'complete'|'partial'|'unavailable'; reasons:readonly string[]}`. Complete means the lane
executed its declared bounded retrieval contract; it does not mean every relevant corpus record
was found. Exact-value completeness is reported separately in lookup.complete.
If measured synchronous SQL exceeds the latency gate, record the failure and isolate the slow
read in a read-only worker before promoting the speed change. Worker requests must be typed,
server-owned operations, not external SQL; pool size is bounded and shutdown reaps workers.

### Literal source anchors

Add optional `Fact.sourceAnchor` and additive fields in both adapters: facts source_start,
source_end, source_body_version, source_quote_status; sessions body_version.
Verified anchor shape: `{status:'verified'; start:number; end:number; bodyVersion:string}`.
Unverified shapes carry no offsets. Missing/stale are `{status:'missing'|'stale'}`; invalid/ambiguous may carry `{status:'invalid'|'ambiguous'; bodyVersion?:string}`. This optional version identifies the exact body assessed, not a verified quote location. Reuse a negative assessment only while it matches the current tenant-owned source version; changed/missing versions are stale and require fresh bounded verification. Historical null negative versions retain the legacy fallback.
Use one shared `bodyVersion(body):string` helper matching the existing 16-hex SHA-256 transcript
version contract. Historical versions/anchors may be null; no startup-wide hashing/backfill.

At write time, resolve a quote against the exact stored body: one literal occurrence -> verified;
zero -> invalid; more than one -> ambiguous. Do not fuzzy-match into a verified quote. The
classifier output is not regenerated just to add anchors. Fact/session/version writes stay
atomic. Reads compare anchor version with the current persisted version, and scoped range
expansion verifies tenant and membership. SQLite substr offsets require UTF-16-aware conversion:
its code-point indexing cannot be treated as JS offsets. Test emoji/non-BMP and combining text.
A portable implementation may return a source body only for expansion until a correct range
adapter passes parity/performance checks; it must not claim avoided body reads prematurely.

Legacy anchors are built on explicitly requested, bounded reprocessing/on-demand verification;
on-demand verification is read-only/ephemeral, and persistence requires an explicit maintenance write.
Keep historical rows readable and fail closed on version uncertainty. They never become verified
because a confidence threshold was passed. No automatic corpus-wide backfill.

### Experiments

T527: compare existing cap 2.0, cap 1.0 (ranking boost disabled, count retained), and relevance
first with corroboration only as a tie-breaker. Freeze the grid before holdout. Count distinct
source sessions as currently implemented; assess copied/replayed sessions as a separate error
stratum. Repetition is metadata, not ground truth. Choose a candidate only through section 5.

Caller-declared deltas: optional seen references identify rendered evidence, not arbitrary known
session IDs. A reference version hashes the full query, resolved scope, intent, packing/policy
revision and canonical rendered evidence. Recompute eligibility each call. Changed query, source,
retirement, scope rebinding or evidence text forces a fresh record or an unavailable tombstone.
A missing/empty seen list returns a full compact bundle. Compaction/new conversation resets seen
state. Supplying foreign IDs never reveals existence. Response counts/coverage remain fresh.
No server-global conversation memory. Add this API only if replay meets the efficiency gate.

Selective decision-model reranking is a separate, default-off experiment after the required
stages. At most eight candidates with total input <=3,000 measured tokens and output <=256 tokens;
return supplied candidate/evidence IDs or abstain. Validate IDs deterministically. Never write
facts or fabricate quotes. Bound its call by the remaining request deadline; on failure retain
the baseline evidence and disclose the skipped/failed advisory stage. The ambiguity trigger is
frozen from development data; classifier self-confidence alone cannot trigger it. All traffic,
including triggered, skipped and failed calls, enters the cost/quality denominator.
The current optional `LLMClient.complete` returns only text, not usage; provider capability
parity is not assumed. Task 9 must either add a measured completion capability to the existing
port/configured adapter/wrappers, preserving old callers, or record no-go. Require exact prompt/
completion token accounting, a provider-enforced output cap and abort/listener cleanup.
Require provider/gateway usage receipts and ClassifierBox forwarding, including failed/timed-out
call reconciliation; tokenizing returned text does not prove billed/cached usage. Unknown
usage remains null. Unavailable accounting or cap enforcement blocks promotion; do not invent zero usage or
truncate an already-unbounded generation and call it a bounded request.

## 5. Measurement contract and promotion gates

All numbers below are proposed acceptance thresholds, not measured improvements. Task 1 freezes
the run manifest before tuning and records any justified revision before inspecting holdout.

### Datasets and controls

- Start with at least 120 source-grounded natural-language questions across exact lookup,
  scoped/paraphrased lookup, rationale, temporal/reversal, multi-value ambiguity, and no-answer.
  Prefer actual operator queries. Labels must be checked against original source text, with
  all required facts/alternatives and minimum sufficient source ranges; never derive correctness
  solely from the current ranker, classifier summary, citation frequency or expected IDs.
- Use source-family/workstream group-disjoint dev/holdout sets (target 60/40; no mechanically
  replayed parent/child source family in both). Each category must be represented. Expand the
  corpus rather than compromising disjointness to meet a convenient row count.
- Keep holdout sealed through Tasks 1–9: all stage tuning/selection uses development data only.
  Before opening it, register the required-only arm, each development-qualified optional arm,
  the combined candidate, any fallback composition, and all contrasts/thresholds. Task 10 runs
  this family once; no stage outcome may adapt the next holdout candidate. Combined failure
  leaves optionals off unless a preregistered fallback independently passes. Account for the
  declared family of quality comparisons using joint grouped bootstrap/simultaneous bounds.
- A separate deterministic adversarial suite covers tenant isolation, unknown/rebound scope,
  >12 and >500 duplicates hiding a second value, retired/superseded alternatives, candidate
  starvation, Unicode anchors, changed source, cancelled calls and stale seen references.
- Annotator reviews complete sources without candidate-arm results. A separate reader answers
  using only each returned bundle; a blinded reviewer scores against frozen labels. Audit every
  arm disagreement and no-answer error plus a seeded 10% of agreements against original text.
  Model judges assist but cannot establish the gold labels or overrule literal validators.
- Pin snapshot hash, commit, tokenizer/model revisions, provider role resolution, prompts,
  dataset hash/split manifest, environment and machine load. Keep source text/private reports
  under `~/.nlm/eval/`, out of git. Keep only synthetic invariants and aggregate results in repo.
- Same snapshot and embedding vectors for ranking-quality comparisons; embeddings must probe
  successfully or the semantic run is unavailable. Live performance runs do not reuse the quality
  run's embedding cache; warm/cold/cache-disabled results are distinct. Never compare cached
  candidate times to uncached baseline times.

### Metrics and decisions

| Change | Required evidence | Promotion condition |
| --- | --- | --- |
| All correctness changes | Backend parity/adversarial contracts | 100% required cases; zero tenant disclosure or silently broadened explicit scope |
| Scoped retrieval | Eligible exact-distance oracle + scoped questions | Oracle top-k IDs/distances within 1e-5; no starvation in fixtures; >=5 percentage-point sufficient-evidence gain on scoped development stratum, confirmed held-out |
| Conflict probe | Full distinct-value oracle | 100% complete/ambiguous fixture detection, including alternatives beyond both old caps; zero false unique answers |
| Deadlines/parallelism | >=30 paired requests per selected real workload, after 5 warmups; reverse arm order | >=20% p95 end-to-end latency reduction; supported-evidence rate not lower; async cancellation fixture settles by deadline+100 ms; SQL segment time separately visible |
| Anchors | Literal range/version oracle + sampled real quoted facts | 100% verified anchors reproduce exact stored quote; zero stale anchors accepted; >=50% less source verification CPU on the quoted-fact workload, no added generative calls |
| Ranking or reranker | Blinded supported-answer/evidence scoring | >=5 percentage-point targeted sufficient-evidence gain, no overall observed quality decline; grouped paired bootstrap 95% lower bound on overall quality delta >=-2 percentage points |
| Delta responses | Replayed repeated-context conversations | >=20% fewer total retrieval-chain tokens, no observed quality decline, all invalidation/compaction tests pass |
| Optional model stage | All request tokens, usage, latency and correctness | Above quality gate; tokens per supported answer <=1.10x baseline and p95 latency within the shared service budget; otherwise remain off |

Define sufficient evidence before scoring: an answerable question's bundle contains every
required claim/alternative and supporting source range; an unanswerable one clearly preserves
absence/uncertainty instead of presenting unrelated evidence as an answer. Report answerable
coverage and no-answer precision separately so abstention cannot game efficiency.

Token reporting includes tool instructions/schema overhead, request arguments, every response
and expansion/refetch, caller reader input/output, and all router/reranker/generative usage.
Separate embedding call count/input usage and cached/billed token fields. Count an identical
caller's initial context in both arms; report incremental memory-chain tokens and total tokens.
Use a pinned actual consumer tokenizer; unsupported counters are null, never estimated zeros.
Report all queries, failures and all strata, plus tokens per supported answer; do not hide costs
by reporting only successful runs or only triggered model calls.

Bootstrap by source/conversation family, not by duplicate question. Size the final holdout using
development-only power estimates before unsealing results: prospectively expand up to 240
held-out questions using frozen selection rules, then evaluate once at that fixed sample size.
Never repeatedly inspect confidence bounds and add rows until a pass.
If still inconclusive, do not promote the optional ranking/model/delta change. Correctness fixes
can land with passing invariants and no observed regressions while their statistical uncertainty
is explicitly reported. Do not revise labels/thresholds after seeing held-out failures; start a
new development cycle and reserve a fresh holdout for a revised candidate.

## 6. Delivery and review

Deliver in the linked implementation plan's order. Each task has one fresh SDD reviewer covering
spec compliance and code quality; do not layer a second duplicate reviewer over the same diff.
Use the workspace code-review lane for code review (Muse Spark 1.3 xhigh, documented fallback),
and a security-focused lens for tenant/scope/expansion changes. Verify every finding against code;
record accepted/rejected findings and tests. Review fixes over their fix diff, not the whole task
again. Final whole-branch review covers interfaces, source integrity, deferred findings and metrics.

Before first code write, SDD preflight checks every task and each shared-file/interface pair;
record the table and rulings in the plan-scoped ledger. Full typecheck/build/test and both DB
contracts precede landing. The repo has no `.agent-quality.yml` at this baseline, so record actual
commands/results rather than claiming a configured gate. Use nxtgit task worktrees and land;
record results in nxttasks with existing T527/T679 linked, not duplicated.

Rollout: record the installed baseline, make a consistent backup, build/test the landed release,
compare frozen replay, then explicitly deploy through the normal installer process. Public
publishing needs its authorized release scope. Canary scope/conflicts/Unicode/timeout across
MCP transports, verify migration idempotence and token/latency telemetry, and retain an additive
schema-compatible binary rollback. A regression restores the prior binary; never delete memory.

[Implementation plan](../plans/2026-10-16-memory-retrieval-improvements.md) ·
[Editable architecture](../../diagrams/memory-retrieval-improvements.drawio)
