# Memory retrieval integration results (T806)

Required correctness work is implemented; optional ranking, evidence deltas and decision-model reranking remain off. Final independent whole-branch review, landing, deployment and live canary are pending. This document is the aggregate results source of truth; private corpus and raw reports remain outside git.

## Frozen final diagnostic protocol

Frozen before opening heldout content. Required candidate `49dd646cbc0b2e5a83d8a11c2953bab4f7925c22` versus compact baseline `a9f072919f2f07feb053c18ffb9d21e219dcfeb2`; runtime required path is unchanged from Task 6/Task 7 default-policy integration. One contrast, candidate minus baseline; no qualified optional, combined or fallback arms. Fixed N=55 from the existing source-audited 120-question dataset (65 DEV / 55 holdout), with no sample expansion.

Primary blinded answer quality, exact consumer tokens and a corresponding development-only power estimate are unavailable. This is a literal-evidence diagnostic and remains scientifically INCONCLUSIVE regardless of its interval. The separate reader receives only question and returned bundle, never labels. Literal containment does not prove semantic answer quality.

Actual pinned TSX handlers run against separate migrated disposable clones with isolated HOME/XDG/runtime/state roots. Five fixed first-DEV questions warm each arm, baseline then candidate, before the measured alternating pairs (baseline first at index 0). A distinct same-baseline DEV control alternates five warmups and five measured pairs. This prospective choice avoids repeating Task 7's unwarmed comparison; startup/deadline artifacts can still occur and will be retained. No control repair or heldout rerun is permitted. Cached quality vectors are identical across arms, captured only through the existing configured `buildEmbedder`; these are not uncached latency measurements. All attempts and partial/failed outcomes remain in the denominators.

The single-comparison 95% diagnostic interval uses the existing paired source-family percentile bootstrap (2,000 resamples, seed 806). With one declared contrast, the familywise interval equals its individual interval. Category rows are descriptive, not additional hypothesis tests. Audit every score disagreement and no-answer error, plus ceil(10%) of remaining score agreements ordered by SHA-256 of `806:<case-id>`. Read original UTF-8 bytes without newline conversion; check ranges as UTF-16 offsets with CR preserved.

Private evidence root: `~/.nlm/eval/memory-context/2026-10-16-T806/task10-final/`.

| Frozen artifact | SHA-256 |
| --- | --- |
| Final preregistration | `1d6e57ecca95961a9a71d784ccc2f06e8dfd4e52940b85519d9c56097d9884a0` |
| Execution manifest | `1f0db151141188a9603eeff3ee696b1c26ea0a946e859c96ccfd3ad7890acb11` |
| Holdout case bytes | `bc23fb06bf33daea9bbbd991ada2eda4a72eddb6bd1aaad4955ab9f52655ba24` |
| Canonical snapshot | `08a6b4f2493ca4128b3c7ae0dac590c4d1ed1b7ba2bd0be9044859be4fbb05c7` |
| Frozen DEV vectors | `46a401d2556014cfe04013c5d700e96ac8b9f2299671ffe6da6776072f104c78` |

A warmup-order wording correction was made before either control outcomes or heldout content was opened; the superseded registration is retained privately. Exact final manifest hash is verified when reporting results.


## Final heldout diagnostic

All 55 preregistered questions ran once. The five measured DEV identical-baseline
control bundles and reader outputs matched exactly after ten warmup calls. Equal
reader outputs also imply equal literal scores for each frozen case. Final arms
received ten additional DEV warmup calls, retained separately from the 110 heldout
responses. There were no retrieval, reader or cached embedding failures; candidate
coverage was complete for both lanes on all 55 responses. The older baseline has
no coverage field, which must not be interpreted as proof of completeness.

| Literal sufficiency stratum | N | Baseline | Required candidate |
| --- | ---: | ---: | ---: |
| Overall | 55 | 1 | 5 |
| Answerable | 49 | 1 | 5 |
| Exact | 23 | 1 | 1 |
| Scoped | 12 | 0 | 3 |
| Rationale | 4 | 0 | 0 |
| Temporal | 6 | 0 | 1 |
| Ambiguity | 4 | 0 | 0 |
| No answer | 6 | 0 | 0 |

Overall literal delta is +7.27 percentage points, with the preregistered grouped
95% interval **[0, +19.35] points** over five source families. Four cases improve;
none lose the binary literal score. This is not confirmed natural-answer quality,
scoped-gate validation or a supported-answer promotion. Answerable coverage is
1/49 versus 5/49; no-answer success is 0/6 in each arm. Neither reader abstains,
so abstention precision is unavailable (zero predicted-abstention denominator).

The source audit read complete raw UTF-8 bodies and validated all 63 labelled
UTF-16 ranges across 17 heldout sources against both source-file hashes and the
frozen snapshot. The selected audit union has 16 cases: all four disagreements,
all six no-answer errors and six seeded score agreements. All 273 distinct
returned/labelled source bodies were also read to validate emitted quotes and
passages. Zero verified-quote or passage contradictions were found. There are 34
nonliteral historical fact-quote occurrences (16 distinct facts), all explicitly
unverified; literal retrieval must not turn those into semantic truth. Selected
source-label agreement does not prove global paraphrase-family independence or
corpus-wide no-answer completeness. No labels, arms or thresholds were changed.

There were 55 successful configured embedding captures, with started and completed
attempts retained; both measured arms then made 55 logical cache reads. The model
reported `text-embedding-nomic-embed-text-v1.5`; current gateway metadata resolved it
to `openai/text-embedding-nomic-embed-text-v1.5@q4_k_m` on the owned LAN inference
server. Immutable weights, provider input/cached/billed usage and exact consumer
tokens remain unknown. Total tokens, incremental chain tokens and tokens per
supported answer are **null**, not zero. External expansions/refetches are zero
by this protocol; internal source hydration reads were not instrumented and remain
unknown. Baseline/candidate returned 401/386 records, which is not a token saving.

After DEV warmups, cached-quality p50/p95 was 299.47/423.45 ms baseline and
309.10/440.76 ms candidate. Cold and uncached-live latency are unavailable for this
run. The candidate's cached p95 is higher; these numbers cannot establish a speed
gain. See the separate earlier live-embedding workload measurements below.

The initial automatic approval review rejected the run before execution because
the embedding destination was unverified. Read-only configuration and current
model-info checks established the existing owned LAN gateway and owned Mac Studio
backing server. The unchanged action was then approved on that new evidence and
executed once. No denied action executed, no alternate provider was substituted,
and no service configuration changed.

## Earlier stage evidence and retained failed gates

Task 2's 15-DEV pilot removed outside-scope primary-source records (19/19 baseline
to 0/18 candidate) with unchanged 2/15 literal sufficiency. These are source-record
and character diagnostics, not relevance/token proof. The later source-audited
120-case dataset resolved the original 94-case shortfall but not tokenizer,
blinded primary quality or power limitations.

Task 3 proves eligible exact-distance top-k via both adapter contracts, including
starvation, ties, multi-chunk sessions, missing chunk maps and native-cap fallback.
The original synchronous unscoped exact scan took about 1.8 s; fallback remains
potentially slow. Task 5 isolates semantic reads in bounded read-only workers and
fixes the scoped fact join order. Task 4's complete-value diagnostic covered 20
structured case/backend combinations and 1,200 repeated checks with zero false
unique answers; those timings excluded the former ambient attribution scan.

Task 5's final run 4 compares pinned `69f4c3faa46f3424918172bb899a1086c092f42c`
to measured source fingerprint
`b735f3de303279022671a65523a83582b984ad4c3797e27a6215b191a4326ce8`.
It precedes the CLI teardown fix and Task 6 anchors. It is retained historical
request-boundary evidence, not relabelled as final whole-branch latency. Five
warmups preceded each selected steady workload; arm order reversed. Earlier
runs 1–3 remain private, including a +19.8% default p95 regression in run 2 and
60 unequal scoped/outage evidence pairs before packing corrections.

| Task 5 workload | Responses/arm | p50 baseline → candidate ms | p95 baseline → candidate ms |
| --- | ---: | ---: | ---: |
| Default broad | 30 | 242.9 → 252.8 | 323.2 → 312.3 |
| Explicit hybrid both | 30 | 371.6 → 291.8 | 496.0 → 384.2 |
| Hybrid scoped | 30 | 5642.7 → 527.9 | 5966.4 → 635.6 |
| Cold connection | 6 | 427.0 → 374.4 | 506.3 → 436.6 |
| Injected outage | 30 | 81.7 → 85.0 | 90.2 → 93.0 |
| Four concurrent | 120 | 1079.9 → 823.5 | 1254.5 → 1030.2 |

All 492 responses remain counted; 245/246 paired responses preserve exact primary
evidence. One scoped response returned partial at 1,533.8 ms and lost one session;
it is not an equal-quality speed win. Baseline scoped embeddings failed on 15/60
attempts; candidate 0/30. Default p95 improvement (3.4%) and loaded improvement
(17.9%) miss 20%; the explicit hybrid gain is workload-specific. Cold n=6 is a
limited connection-cold diagnostic, not a flushed-OS-cache claim. No broad latency
promotion follows. SQL-segment and embedding-attempt details remain in run 4;
cancelled native work can outlive request settlement. Actual token costs remain null.

Task 6 sampled all 256 selected quoted legacy facts (95 unique, 142 absent, 19
ambiguous) without exclusion. Verification CPU, excluding DB I/O/source loading,
rose 18.08% on the actual legacy population (515.492 → 608.684 ms per 51,200
operations). The proposed 50% reduction **failed**. Counterfactual current-version
assessments reduced CPU 99.08% and the uniquely verified subset 97.41%; neither
is deployed historical-corpus performance. Partial/final hybrid publication can
read the same unchanged legacy body twice (deferred advisory A1). Deduplication is
per hydration call; no request-wide I/O-saving claim is made. Changed/null versions
must continue to refetch; no optimization was added merely to preempt review.

| Optional stage | Outcome | Production disposition |
| --- | --- | --- |
| [Corroboration/default-session ranking](memory-corroboration-experiment.md) | DEV cap1/tie 11/65 vs baseline 10/65; hybrid arms 2/65. Identical control matched 65 scores but only 64 readers/bundles; first cold deadline artifact retained. INCONCLUSIVE / NO-GO. | Cap2 and hybrid-facts/keyword-sessions default unchanged; no qualified optional arm. |
| [Caller evidence deltas](memory-evidence-delta-experiment.md) | Actual tokens, qualified repeated-context traces and blinded quality unavailable. INCONCLUSIVE / NO-GO. | No delta API, seen state, cache or runtime overhead. |
| [Decision-model reranking](memory-decision-model-experiment.md) | Configured completion discards usage/model; enforced cap, abort behavior and failed-call accounting unqualified. INCONCLUSIVE / NO-GO. | No reranker, measured completion framework, trigger or generation call. |

## Mandatory contract and test ownership

Paths below identify executable contract owners, not claims that source tests
prove natural-query scientific thresholds. All referenced suites are included in
the final full run with PostgreSQL enabled.

| Spec clause / boundary | Implementation owner | Test/evidence owner and disposition |
| --- | --- | --- |
| Authenticated tenant only; no scope broadening | Task 2: `resolve-scope.ts`, `mcp/server.ts` | `recall-workstream-filter.test.ts`, `mcp-context.test.ts`, tenant-leak contracts; unknown/foreign/cyclic scope fails closed. |
| All-accessible omitted scope; fresh expansion membership | Task 2: recall services and MCP expansion handlers | `mcp-context.test.ts`, workstream-filter suite; rebinding and exact selectors tested. |
| FactEligibility before limit; session metadata before top-k | Tasks 2–3: SQLite/PG fact/session stores | `scoped-semantic-recall.contract.ts` via SQLite and actual PG; exact oracle, ties, starvation, maps and cap fallback. |
| Complete current values, no first-12/500 uniqueness shortcut | Task 4: both `summarizeCurrentValues` adapters | `fact-store.contract.ts`, `current-value-summary.test.ts`, `mcp-context.test.ts`; >12/>500, retired/superseded, consistent snapshot. |
| Atomic evidence and 2,000–20,000 serialized guard | Tasks 4–5: context bundle / response budget | `mcp-context.test.ts`, `coverage-packing.test.ts`; long escaped selectors preserved, optional metadata removed before evidence. |
| Shared monotonic deadline, 1,500 default /100–5,000 option | Task 5: request budget / execution options / MCP | `context-deadline.test.ts`, `recall-context.test.ts`; cancellation and remaining budgets. Main SQLite cooperation explicitly limited. |
| Parallel lanes; exact lookup skips session/embedding | Task 5: `recall-context.ts`, recall services | `recall-context.test.ts`, `mcp-recall-logging.test.ts`; no phantom session search. |
| Identity/query/kind-local embedding reuse; lexical survival | Task 5: request budget / recall services | `context-deadline.test.ts`, fact/service tests; one shared promise, failed/pre-aborted paths retained. |
| Honest partial coverage; immutable publication; count reuse | Task 5: context hydration/packing, fact service | `coverage-packing.test.ts`, `corroboration-reuse.test.ts`; explicit zero counts, no cross-request cache. |
| Bounded typed read-only semantic pool; shutdown cleanup | Task 5: SQLite semantic reader/worker and CLI | `sqlite-semantic-reader.test.ts`, compiled `mcp-stdio-lifecycle.test.ts`; EOF/transport/repeated signals reap workers. |
| Remove unbounded ambient attribution work | Task 5: MCP attribution | `mcp-no-ambient-attribution.test.ts`, `mcp-cite-session-attribution.test.ts`; trusted tenant context or null. |
| Exact persisted-body literal location, UTF-16 and normalized writes | Task 6: source anchor/version helpers and all extraction writers | `source-anchor.test.ts`, both source-anchor adapter contracts; emoji, combining text, malformed surrogates, repeated/absent quotes. |
| Current positive/negative assessment; stale/null fail closed | Task 6: fact/session adapters, context and expansion | `fact-source-anchor.test.ts`, `.pg.test.ts`, `mcp-context.test.ts`; version/tenant/membership and legacy fallback. A1 repeated hydration parked. |
| Nullable additive migration; old-writer/FTS safety | Task 6: SQLite043/PG039 | Both source-anchor-upgrade suites, adapter contracts, `fts-index.test.ts`, final PG migration assertions. 042/PG038 unmodified. |
| No added generation, corpus backfill, retirement or policy change | Tasks 2–6: request/extraction paths | Request/ingest/extraction suites and source review; existing classifier output reused. No installed mutation. |
| Frozen source gold, group split, pinned arms and vector equality | Tasks 1/7/10: evaluator and private manifests | `memory-context-eval.test.ts`, `context-score.test.ts`; 120 audited questions, one-shot55 diagnostic, all hashes retained. Global paraphrase independence unproven. |
| Reader isolation; all failures/costs; exact tokens or null | Tasks 1/10: literal reader, cost ledger | Evaluator tests and private audit; no-answer and answerable denominators separate; tokens/primary quality unavailable. |
| Prospective N/contrasts/control, grouped bounds, no tuning | Task 10: consumed registration gate | Evaluator tests reject changed hash/pins/N and repeated attempt; final frozen N55 one contrast. No scientific promotion. |
| Conditional optional ranking/delta/model gates | Tasks 7–9 | Evaluated capability/DEV prerequisites; all no-go. Unimplemented delta invalidation/model-cap tests are not claimed as passes. |
| Full gates, generated parity, review, local landing | Task 10 + controller | Full results below; final independent combined Task10/whole-branch review and landing controller-owned/pending. |
| Compatible binary, backup, deployed MCP canaries | Controller release scope | Pending deployment authorization. No backup/migration/install/live canary performed here. |

## Review findings and integration verification

Accepted findings were fixed and scoped re-reviewed: Task 1 bootstrap low-bit
correlation, live-HOME leakage, answerable-only token denominator and unique cost
invocation IDs; Task 2 scoped relatedFacts leak plus stale resolver comment;
Task 4 exact selector shortening; Task 5 stdio worker shutdown. Tasks 3 and 7–9
had no new actionable findings. Task 6 A1 remains a documented nonblocking I/O
limitation for final review. Scientific gaps are not converted into engineering
passes: failed optional quality, unavailable exact tokens and nonliteral quotes
already marked unverified were rejected as *new code defects*, while retained
as measurement limitations. All controller rulings, including why/cost, are in
[the durable rulings appendix](memory-retrieval-rulings.md).

Final checks on the implemented source:

- `npm run typecheck`: passed all server/test/script projects.
- `npm run build`: passed server, UI and all four generated hook bundles.
- First full `npm test` with actual local PostgreSQL: 3,274 passed, four failed,
  three skipped. All four failures were stale PG038 expectations in
  `pg-migrate.pg.test.ts` (three) and `registry-actions.pg.test.ts` (one), after
  additive PG039. Only those exact expectations changed; the failed log is retained.
- Covering PostgreSQL rerun: 15 tests / two files passed.
- Final full `npm test` with `NLM_PG_TEST_URL` configured: **3,278 passed, three
  skipped; 376 files passed, one skipped**. All PG-backed contracts ran.
- The three skips are the pre-existing opt-in `bundled-embedder.live.test.ts`:
  unit-vector/model identity, related-versus-unrelated similarity, and the
  fresh-install semantic recall slice (`NLM_BUNDLED_EMBED_TEST` unset).
- Rebuilt `plugin/scripts/{prompt-recall-hook,stop-hook,session-start-hook}.mjs`
  and `nlm/index.js` match tracked output; no generated diff. Current build uses
  the checked source and package version 0.21.17. No agent-quality config exists;
  no configured agent-quality gate is claimed.

All owned pinned executor children, clones and detached worktrees were reaped;
private evidence remains. The pre-existing PostgreSQL test container remains running.
The runtime source/evaluator used by the frozen heldout run is unchanged by the
remaining schema-expectation and documentation edits; no heldout-driven code tuning
occurred. Prior live benchmarks were not repeated for documentation-only changes.

## Installed state and rollout

The installed CLI still resolves `~/.local/share/nxt/os/nlm/current` to
`versions/0.21.17-t730`, package 0.21.17. Its **app/**`dist/mcp/server.js` SHA-256 is
`80edf8e088fc7a3053db18da814f2c16b2c8e5714c65a9e2c2f6ca14adac9f88`;
it lacks `recall_context`. Source and installed features therefore differ even
though package versions match. Earlier capture/schema task titles cannot prove
this branch is deployed or that installed hook latency is fixed.

Before deployment: finish independent whole-branch/spec/security review and
`nxtgit land`, preserve a consistent backup and prior compatible binary, then use
the authorized installer. Additive migrations retain null legacy state and
old-writer guards; rollback restores the compatible binary and never deletes the
corpus. Live MCP scope/hidden-value/mid-transcript Unicode/stale-version/outage/
repeated-context-reset canaries and emitted usage/payload checks remain pending.
No public publish, push, live DB write or installed config change occurred here.

## Evidence digests

Paths below are relative to the private T806 evidence root. Source text is not
committed. Hashes identify the retained reports, not a claim of independent review.

| Artifact | SHA-256 |
| --- | --- |
| `task10-final/heldout.json` | `148d66527906c7408679876b7e17e7d0dbbeebc3a700286dc3d264361b598911` |
| `task10-final/control.json` | `04a4a4eb7840eeee45645080560952b8ae7369975859aefae604debe9310af0b` |
| `task10-final/audit.json` | `ff2b199e89587a2912b3bcde78d9341fedcef8177f8020abe5b2d5887bd33091` |
| `task10-final/query-vectors.json` | `aac8684052819441a3a9abcdd354a2c01e18b4c9de888669a880139235cceb68` |
| `task10-final/run.mts` | `3fa46cbf78ff26110ebae0dcf5e5018e74e6f352d72e8a86ef41a4b82b0f1644` |
| `task10-final/audit.py` | `664b91eb381e720b66af47220f9a7e4251111ac621859cff5e104c8a91893fd6` |
| `task10-final/embedding-attempts.jsonl` | `6c775ed17bb0696fe1c9cf0fb930d1b6b1ea2007b5f25a62e19ff7d67bf84dca` |
| `task10-final/warmups.json` | `1a01fd41929bbb07bb60d67d9f2fde4c0ea63e1fb0450d7da6cf06aba9839f73` |
| `task10-final/typecheck.log` | `e76348b772358126a135ff6f56f5670776a854b84b2aac6e35a1f772e727db7c` |
| `task10-final/build.log` | `e3a68d7fb04361b44fe37ad56e466c68aa4305dcecdc067114c1912289947596` |
| `task10-final/test.log` | `b8eb5b3688f145b95ebbcf9c6242cf97a583fc9b6ce28ae1d69b2e0641958782` |
| `task10-final/test-final.log` | `f95a38080a0321696fc2be97b008ecf92b5c08b4392eac7c0155e4fd31740c50` |
| `task10-final/pg-covering.log` | `f7b5bd23f643c714905f77a900c0baa71575a8517d6746d7586229e707a68f9e` |
| `task5-performance/run4/report.json` | `a625c2f01ed22f01f56497c87d886dd03ad883630deea7a01a5679affc6ad28f` |
| `task6-anchors/cpu-results.json` | `99a8cb2994a9512533b36d023b1757538b6ff5bf59511a076652f94db445ee85` |
| `task7-ranking/aggregate.json` | `ccfb2a628f03ee238b452ae0424dba67b8c6a5618e452f5db4d9ac5a47143782` |
| `task7-ranking/control-equivalence.json` | `8fd0c24231abc1a014f3d6b8cb7a6caef485c1518298d11bc655154afed1bed4` |
| `task8-deltas/audit.json` | `ff91e26776d7f0206459f4ef3b3475468202bbc55b540a382b4cdf607b7f5253` |
