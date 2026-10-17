# Task 7 report — corroboration / retrieval-mode DEV experiment

**Status:** implementation complete for independent review; optional policy/mode
qualification **INCONCLUSIVE / NO-GO**. No candidate is registered for heldout.
Production cap/default selection is unchanged. Tasks 1–6 code baseline:
`c40fa305894686599c90c10c3b5d90b9d7f38164`. Implementation pinned before quality runs:
`78342db4fc682f2cc152d33a2bb1aeabbb0d503a`. This report is committed separately after those immutable runs.
Root owns plan/spec/ledger status and T527 task synchronization; no duplicate task
was created. Task 10 owns full-suite checks, heldout preregistration and any promotion.

## Implementation and focused checks

- Pure `CorroborationPolicy = (count: number) => number` plus explicit tie behavior
  is injected through `FactRecallServiceDeps.corroborationRanking`. Default omission
  evaluates the same existing cap/environment policy as before. Count/store semantics
  and the structured exact-value path are unchanged; no records are retired.
- Three policies: cap2 factor/count ties; cap1 unit factor/stable native ties with
  counts retained; tie-only unit factor/count ties after relevance. No process-global
  environment mutation is used to configure concurrent arms.
- Evaluator support runs actual pinned FactRecallService, RecallService and compact
  handler on cloned read-only snapshot inputs, with isolated HOME/XDG/runtime paths.
  Mode default omits the mode argument (facts hybrid/sessions keyword); explicit
  hybrid uses the existing shared embedding capability. Keyword remains explicit.
  Cache hash/case/model/dimension/query-kind checks fail loud. Snapshot prose config
  is checked before execution. No prototype/global monkeypatch replaces a baseline.
- No query-time generative/routing model, new provider or embedding is introduced.
  `report.arms` records actual mode/policy/cache overrides; the hashed original
  keyword-control input manifest is retained unchanged. This distinction matters
  when inspecting the raw report's `manifest.mode`.
- Synthetic tests cover disabled metadata retention, zero-relevance exclusion,
  concurrent pure-arm isolation, relevance ties, alternative facets, distinct
  session versus copy-component metadata without independent-truth claims, cached
  model-attempt accounting, immutable cache rejection, and actual pinned service
  default/hybrid/keyword logical calls.

RED: added three policy tests failed with `corroborationRanking is not a function`;
the five existing policy tests passed. GREEN after implementation/fixes:

```sh
npx vitest run tests/unit/core/recall-facts/fact-corroboration.test.ts \
  tests/integration/memory-context-eval.test.ts tests/unit/core/context \
  tests/unit/core/recall/request-budget.test.ts \
  tests/integration/context-deadline.test.ts --reporter=dot
npm run typecheck
```

**37 tests across five matching files passed; all three TypeScript configurations
passed.** The request-budget filename filter matches no standalone file; budget
and sharing regressions are exercised by context and deadline files in that run.
An intermediate pinned-cache test assertion incorrectly counted the initial
`retrieval:started` lifecycle event as a failed event; corrected to check completed
embedding attempts. Generated runner config access was verified against
`embeddingConfig.getLane`, then exercised on a synthetic configured snapshot.
`git diff --check` and staged diff review passed. Self-review was performed once
on the final implementation. No configured `.agent-quality.yml` exists here.
No full-suite/build/backend gate is claimed at this stage; root runs Task 10 gates.

## Prospective registration and immutable inputs

The six-arm grid was frozen before any quality outcomes: cap2, cap1, tie-only x
production default, explicit both-hybrid. At most one candidate could qualify.
The target was overall sufficient evidence, +5 pp, no observed overall decline,
family-bootstrap lower bound >= -2 pp, and independently blinded supported-answer
review. Unavailable/low-powered quality means inconclusive/off. All 65 DEV rows,
all strata, attempts and partial/failed retrievals remain in denominators.

Private root: `/Users/echalupa/.nlm/eval/memory-context/2026-10-16-T806/task7-ranking`.
The preregistration is read-only and its original bytes remain unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Preregistration | `7c187208ee62ad6cda6673c689c5bd51c8067d863006640f27e5584148aaf603` |
| Execution pin | `62c8f9c7f247f8605d86914472db7d59d1ff858ba8ead64f9d2a5868ca446db8` |
| Original DEV execution manifest | `dff56c6114a45f2f9703ec7e5d14b6c888de3aa715fdb8a0f239a841ed7078d0` |
| DEV cases (65) | `3a0f047ef86a308bb69987270a2511886040e1828a1840854ad23b9296e23b9f` |
| Frozen query vectors | `46a401d2556014cfe04013c5d700e96ac8b9f2299671ffe6da6776072f104c78` |
| Snapshot | `08a6b4f2493ca4128b3c7ae0dac590c4d1ed1b7ba2bd0be9044859be4fbb05c7` |
| Evaluator source at pinned implementation | `5ac676082e61d29499c8d7855763440ba16ce73a0e2b01b8dabfcfdf9eecadbb` |
| Literal-reader prompt metadata | `955564eaba0c3a2c0258d273e06231c24e6b7f235d5ad943d452dcf23e54b43a` |
| Private six-arm executor | `b48d3f6151db51a62a23087dc0bc3ac7e7873a791bc88133443a6081278c0332` |
| Aggregate | `ccfb2a628f03ee238b452ae0424dba67b8c6a5618e452f5db4d9ac5a47143782` |
| Source audit | `61498ddf5a2aed6bc0338ac3cb03ef464e8b406472e04bc702a2594382a78f6c` |
| Classification audit | `e31d53d6625b0261f6ae4f683a1a2114ce3de283e16bb75039f181adc2510b0f` |
| Exact control equivalence audit | `8fd0c24231abc1a014f3d6b8cb7a6caef485c1518298d11bc655154afed1bed4` |
| Final private artifact hash catalog | `b36f7c798e59156786a2c264464113fbef9f7a3d7302a3b3008c6171a1a7863d` |

Source-body, source-audit/provenance/split-lineage metadata hashes are frozen in
preregistration. Per-arm report hashes and category CIs are in `aggregate.json`;
`artifact-hashes-final.json` catalogs the complete private execution/audit artifact set.
The prompt/reader are the unchanged literal-containment diagnostic. The embedding
model's reported identifier is frozen; provider input usage and model weight
digest are unavailable, not invented. No heldout questions/cases/outcomes were
opened. Only permitted split/source lineage metadata and aggregate totals describe
55 sealed heldout cases (120 total).

Reproduction used private `run-grid.py`, which sequentially invokes:

```sh
node --import ./node_modules/tsx/dist/loader.mjs scripts/eval/memory-context.ts \
  --manifest "$DEV_MANIFEST" --baseline c40fa305894686599c90c10c3b5d90b9d7f38164 \
  --candidate 78342db4fc682f2cc152d33a2bb1aeabbb0d503a --baseline-mode default \
  --candidate-mode "$MODE" --candidate-policy "$POLICY" \
  --vectors "$DEV_VECTORS" --vectors-sha256 "$FROZEN_VECTORS_SHA256" \
  --out "$PRIVATE_ARM_REPORT"
```

Every run uses a fresh snapshot clone before migrations, separate pinned executor
processes, alternating paired execution order by case, and cleanup of its detached
worktrees/processes. No installed daemon/config/corpus was modified; the existing
Postgres container was not touched. No rerun-to-clean, time-budget change, grid
revision or outcome-dependent label adjustment occurred.


## Frozen DEV outcome: inconclusive / NO-GO

No ranking or session-mode candidate qualifies for Task 10. The best literal
containment change is 1/65 (+1.54 pp), below the preregistered overall +5 pp gate.
Blinded supported-answer certification and a defensible primary-outcome power
estimate are unavailable. Full-bundle control equivalence failed on one partial
baseline request, so the overall scientific comparison remains inconclusive.
Production behavior stays unchanged; heldout remains sealed.

| Arm | Baseline /65 | Arm /65 | Delta pp | Family-bootstrap 95% CI pp | Cached logical attempts B/A |
| --- | ---: | ---: | ---: | --- | ---: |
| cap2__default | 10 | 10 | 0.00 | [0.00, 0.00] | 65/65 |
| cap2__hybrid | 10 | 2 | -12.31 | [-21.57, -1.89] | 65/65 |
| cap1__default | 10 | 11 | 1.54 | [0.00, 5.26] | 65/65 |
| cap1__hybrid | 10 | 2 | -12.31 | [-21.57, -1.89] | 64/65 |
| tie-only__default | 10 | 11 | 1.54 | [0.00, 5.26] | 65/65 |
| tie-only__hybrid | 10 | 2 | -12.31 | [-21.57, -1.89] | 64/65 |

All rows retain 65 DEV cases and five source families. These are unblinded literal
reader diagnostics, not natural-answer accuracy or promotion-quality intervals.
A zero-width control score interval does not establish bundle equivalence or
zero underlying uncertainty. There were zero event-level exceptions/failed model
attempts, but six baseline request instances had explicitly incomplete coverage:
four fact-partial and two fact/session-unavailable. Every candidate request
reported both lanes complete. The failed control and all incomplete cases remain
in the original reports; nothing was rerun or excluded.

| Arm | Exact /18 | Scoped /14 | Rationale /10 | Temporal /8 | Ambiguity /4 | No-answer /11 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cap2__default | 3 | 4 | 1 | 1 | 1 | 0 |
| cap2__hybrid | 0 | 2 | 0 | 0 | 0 | 0 |
| cap1__default | 4 | 4 | 1 | 1 | 1 | 0 |
| cap1__hybrid | 0 | 2 | 0 | 0 | 0 | 0 |
| tie-only__default | 4 | 4 | 1 | 1 | 1 | 0 |
| tie-only__hybrid | 0 | 2 | 0 | 0 | 0 | 0 |

All baseline runs have category successes 3/18, 4/14, 1/10, 1/8, 1/4 and 0/11 in
that order. Answerable coverage is baseline 10/54, cap1/tie-only default 11/54,
and every hybrid arm 2/54. No-answer success is 0/11 throughout: the literal reader
returns non-abstention when any records are packed, even on complete no-answer
bundles. Predicted-abstention precision is null (0 predictions), except the
cap1/hybrid and tie-only/hybrid baselines, which have 0/1 due to an unavailable
answerable request. An unavailable empty result is not a genuine no-answer success.

The one default-mode diagnostic gain is a complete/complete paired case: fact
packing changes from six records/3,198 serialized characters to five/2,812,
permitting two session records instead of one; the additional session contains
the frozen required literal range. It is a directly inspected packing effect,
not explained by the observed first-request deadline variance. It remains a
single unblinded engineering result below the overall gate; no category target
was substituted after observing it.

Each hybrid arm loses the same eight baseline-success cases. In seven, the
intended source is absent from the compact bundle; in one, the source is present
but the required literal is outside the packed evidence. This does not identify
whether a missing source was absent from the pre-packing search candidates and
does not establish that hybrid retrieval is generally worse.

The source audit covers 47 evidence/score-disagreement cases, all 11 no-answer
error cases, and two of 18 agreements selected by SHA256(seed 806 + case ID):
51 distinct audited cases after overlap. All 65 gold cases/71 UTF-16 ranges
match raw UTF-8 source bytes, hashes and exact persisted bodies. Across the
1,859 audited returned-evidence occurrences, 328 nonliteral entries are historical
fact quotes explicitly marked `quoteVerified=false` (22 unique source/text pairs).
No nonliteral session passages or `quoteVerified=true` contradiction were found.
The literal reader includes unverified quotes and tests required text containment;
it cannot certify claim truth, acceptance, absence, contradictions or unsupported
additional claims. Source labels were audited independently before outcomes;
this deterministic audit does not substitute for an arm-blinded semantic reviewer.

Of 303 distinct returned triples, 29 have multiple stored source sessions; seven
share recorded ancestry. No exact-body copy group was detected among those
repeated triples' source bodies. These are separate session/lineage diagnostics,
not counts of independent truth. Global paraphrased replay independence remains
unproven. The full source dataset has 36 selected sources/10 families; this run
uses 19 DEV sources/five families. Category groups are sparse (three to five).

Quality execution used the same immutable 65 x 768 query vectors in every arm,
reported model `text-embedding-nomic-embed-text-v1.5`, matching frozen snapshot prose
configuration. All 778 logical attempts hit the cache; actual provider calls were
zero. The two zero-attempt baseline requests explicitly reported both lanes
unavailable. On complete requests, default and both-hybrid each use one shared
logical embedding; the focused pinned test independently checks this invariant
and explicit keyword's zero calls. Input usage, billed/cache tokens, model weight
digest and consumer token counts remain null. Cached-quality timing retains the
real service deadlines but cannot establish live performance; no latency or token
efficiency gain is claimed.

Private preregistration `7c187208ee62ad6cda6673c689c5bd51c8067d863006640f27e5584148aaf603`;
aggregate `ccfb2a628f03ee238b452ae0424dba67b8c6a5618e452f5db4d9ac5a47143782`;
source audit `61498ddf5a2aed6bc0338ac3cb03ef464e8b406472e04bc702a2594382a78f6c`;
classification audit `e31d53d6625b0261f6ae4f683a1a2114ce3de283e16bb75039f181adc2510b0f`.
All source text, per-case outputs, scripts and logs remain under the private
`~/.nlm/eval/memory-context/2026-10-16-T806/task7-ranking/` directory.


## Coverage and control evidence

| Paired run | Baseline incomplete /65 | Candidate incomplete /65 | Actual returned baseline reasons |
| --- | ---: | ---: | --- |
| cap2__default | 1 | 0 | facts_deadline_or_cancelled: 1 |
| cap2__hybrid | 1 | 0 | facts_deadline_or_cancelled: 1 |
| cap1__default | 1 | 0 | facts_deadline_or_cancelled: 1 |
| cap1__hybrid | 1 | 0 | sessions_deadline_or_cancelled: 1, facts_deadline_or_cancelled: 1 |
| tie-only__default | 1 | 0 | facts_deadline_or_cancelled: 1 |
| tie-only__hybrid | 1 | 0 | sessions_deadline_or_cancelled: 1, facts_deadline_or_cancelled: 1 |

**Full-bundle control equivalence FAIL:** the first DEV question has fact-partial
baseline coverage with explicit `facts_deadline_or_cancelled`; cap2/default
candidate has complete coverage. Its score is insufficient in both arms, but
its extracted reader text/evidence and full bundle differ. Across other baseline runs that same question is partial or,
in two, both lanes unavailable with explicit session/fact deadline reasons.
This is the only baseline-variation case and the only full-control mismatch.
All 65 control scores match; 64/65 reader answers and full bundles match.
`control-equivalence.json` records exact comparisons and coverage. Earlier progress
notes that claimed full reader-answer equivalence are explicitly superseded.
Do not infer the first-case reason's
mechanism from cache status: real service deadlines still run, and cache reuse
does not guarantee completion. Event-level success means the handler returned,
not that both evidence lanes completed. Six incomplete request instances stay in
the denominators and raw event/coverage artifacts.

## Retrieval diagnostics and stratified intervals

| Arm | R@1 | R@5 | MRR |
| --- | ---: | ---: | ---: |
| cap2__default | 0.0185 | 0.0741 | 0.0623 |
| cap2__hybrid | 0.0185 | 0.0556 | 0.0388 |
| cap1__default | 0.0185 | 0.1111 | 0.0666 |
| cap1__hybrid | 0.0185 | 0.0741 | 0.0394 |
| tie-only__default | 0.0185 | 0.1111 | 0.0666 |
| tie-only__hybrid | 0.0185 | 0.0741 | 0.0394 |

The baseline has R@1 .0185, R@5 .0741 and MRR .0623 on 54 answerable rows. These
source-ID metrics use compact packed fact-first/session-second unique-source
order and any expected source match. They are packing/source-selection diagnostics,
not raw search rank or sufficient evidence. Equivalent source copies and richer
answers may be penalized by exact expected-source/range containment.

Category bootstrap 95% delta intervals (percentage points):

| Arm | Exact | Scoped | Rationale | Temporal | Ambiguity | No-answer |
| --- | --- | --- | --- | --- | --- | --- |
| cap2__default | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] |
| cap2__hybrid | [-33.33, 0.00] | [-40.00, 0.00] | [-14.29, 0.00] | [-25.00, 0.00] | [-50.00, 0.00] | [0.00, 0.00] |
| cap1__default | [0.00, 18.75] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] |
| cap1__hybrid | [-33.33, 0.00] | [-40.00, 0.00] | [-14.29, 0.00] | [-25.00, 0.00] | [-50.00, 0.00] | [0.00, 0.00] |
| tie-only__default | [0.00, 18.75] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] | [0.00, 0.00] |
| tie-only__hybrid | [-33.33, 0.00] | [-40.00, 0.00] | [-14.29, 0.00] | [-25.00, 0.00] | [-50.00, 0.00] | [0.00, 0.00] |

Overall intervals are the existing core seeded 2,000-draw paired family bootstrap.
Supplemental category intervals use 2,000 paired family draws, Python RNG seed 806;
exact/scoped have five groups, no-answer four, and rationale/temporal/ambiguity
three. They are exploratory DEV diagnostics, not simultaneous heldout bounds.
Sparse groups, chosen option-heavy labels, selected-source lineage and unproven
global paraphrase independence limit their meaning. Neither zero-width score
bounds nor a nominal exact-category +5.56 pp gain changes the frozen overall gate.

## Methodology review, accepted/rejected findings and decision

Accepted: sources and literal ranges are grounded (71/71); stored repetition is
separate from independence; complete paired default-mode packing explains one
literal-range recovery; three hybrid variants lose required evidence in specific
recorded compact bundles; first-case deadline coverage prevents full control
matching; the current literal reader includes disclosed unverified historical
quotes and fails all 11 complete no-answer bundles. Each is engineering followup
evidence for T527, not an end-to-end supported-answer finding.

Rejected: treating one recovered range or R@5 as promotion quality; labeling the
328 disclosed unverified historical quotes as trusted-quote violations or model
hallucinations; claiming hybrid is generally inferior; counting repeated sessions
as independent truth; using character counts as tokens; reporting cached times
as live speedups; interpreting zero event exceptions/score-control CI [0,0] as
complete retrieval or scientific equivalence.

**Selection:** no qualified candidate; cap1 and tie-only remain injected,
evaluator-only dependencies. Neither is enabled for production or passed to
Task 10 as a development-qualified optional arm. Production retains current cap2
and session keyword default, with existing explicit modes preserved.

**Power:** final sample-size estimate is honestly unavailable (null). Primary
blinded supported-answer outcomes are unavailable and only five DEV families are
observed; the small unblinded literal-diagnostic discordance cannot justify a
primary-outcome power estimate. No claim that <=240 heldout questions suffice is
made. Task 10 must preregister its fixed sample (maximum 240 under the binding
spec) and any qualified family before a single heldout opening; no intermediate
heldout sampling, expansion-until-pass or tuning was performed here.

## Handoff and remaining concerns

Root's independent review must cover both the minimal code and this scoring/control
methodology. Full-suite/build/backend gates and any deployment are outside this
stage. The known Task 6 repeated legacy-body hydration advisory remains deferred;
this task did not add a hydration cache. T527 should receive the pinned code/report
SHAs, NO-GO, all denominator/coverage caveats and source-copy distinctions. Plan,
spec and ledger files were left to root. No deploy/push/backfill was attempted.
