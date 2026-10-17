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
