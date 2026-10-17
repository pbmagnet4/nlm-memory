# Corroboration and session-mode experiment (T806 Task 7)

Development only. Production retains its existing cap-2 corroboration policy and
facts-hybrid/sessions-keyword default. No optional arm is enabled by this work.
Task 10 owns any independently qualified, preregistered heldout comparison.

`FactRecallService` accepts a pure `corroborationRanking` dependency containing a
`CorroborationPolicy` factor and an explicit count tie-break switch. Omission
retains the existing `NLM_FACT_CORROBORATION_BOOST_CAP` behavior. Store counts
still describe distinct source sessions; repeated/copied sessions do not establish
independent truth. Cap 1 retains count metadata; tie-only applies the same unit
factor but uses counts on equal relevance scores. No facts are retired.

The private six-arm preregistration SHA-256 is
`7c187208ee62ad6cda6673c689c5bd51c8067d863006640f27e5584148aaf603`.
It freezes cap2/cap1/tie-only crossed with production-default/explicit-hybrid,
all 65 DEV cases, the post-correctness baseline `c40fa305894686599c90c10c3b5d90b9d7f38164`,
case/source/cache hashes, overall targeted gain, all disagreement/no-answer audits,
a seeded agreement sample, and unavailable-measurement NO-GO rules before outcomes.
The source audit's global paraphrase/replay independence caveat remains binding.

The existing evaluator accepts these additive flags:

```sh
npx tsx scripts/eval/memory-context.ts \
  --manifest "$DEV_MANIFEST" --baseline c40fa305894686599c90c10c3b5d90b9d7f38164 \
  --candidate "$PINNED_IMPLEMENTATION" --baseline-mode default \
  --candidate-mode hybrid --candidate-policy cap1 \
  --vectors "$DEV_VECTORS" --vectors-sha256 "$VECTORS_SHA256" --out "$PRIVATE_REPORT"
```

`default` omits the mode argument, `hybrid` explicitly selects both lanes, and
`keyword` retains the original evaluator control. The default evaluator flags
remain keyword. Each arm runs actual services at a pinned commit on a cloned
snapshot with isolated HOME/XDG/runtime state; no prototype or environment
mutation stands in for the baseline. Frozen cache entries must match the case
hash, query kind, reported model, dimensions, and snapshot prose configuration.
Missing cache entries fail and remain visible in the event ledger.

The immutable input manifest retains its original keyword-control contract;
`report.arms` records the actual retrieval mode, policy and vector-cache override.
Cached logical embedding attempts are recorded separately from zero actual
provider calls. Their usage, billed tokens, cached tokens and model weight digest
remain unknown. Cached timing is not live performance; no latency gain is claimed.
The literal reader and source-range containment score are engineering diagnostics,
not blinded semantic supported-answer certification. Consumer tokenizer counts
remain null. Unavailable or low-powered measurements cannot qualify an optional arm.

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
