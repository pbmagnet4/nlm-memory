# Learner-M4 report: recall-chain integration landed

Brief: `.superpowers/sdd/learner-m4-brief.md` (spec §5, amended — see below).
Date: 2026-10-06.

## Landed (8 touch points, not 4)

- `src/shared/types.ts`: `RecallQuery.withRelatedConcepts?`,
  `RecallResult.relatedConcepts?`, `RelatedConcept`
  (concept/status/attemptCount/nextStep-per-enrollment).
- `src/core/recall/related-concepts.ts` (new): `pickRelatedConcepts` —
  top-5 hits → `getWorkstreamIds` → active enrollments →
  `summarizeConcepts` → practicing-first rank → cap
  (`NLM_HOOK_CONCEPT_LIMIT`, default 5). Fail-open (any throw → []).
- `src/core/recall/recall-service.ts`: `learnerDeps?` + attach block after
  facts (flag + deps + `NLM_HOOK_INJECT_CONCEPTS` kill switch, default true).
- `src/http/app.ts`: `?withConcepts=true`, hook-source automatic (facts
  precedent). `src/cli/nlm.ts` buildStack wires
  `learnerDeps: { learners: storage.learners, sessions: store }`.
- `src/hook/recall-over-http.ts`: maps `relatedConcepts` (absent → [],
  old-server tolerant); hook URL passes `withConcepts=true` explicitly.
- `src/hook/prompt-recall-hook.ts`: `RecallFetchResult.concepts?` +
  pass-through as the 4th `formatPointerBlock` arg.
- `src/core/hook/pointer-block.ts`: `## Learning state` section — concept
  lines + deduped Next lines (cap 2, 120 chars). Empty → no section.
- Step 0: `listEnrollmentsByWorkstreams` on the port + both stores +
  contract (now 20 tests); M2/M3 fakes extended.

## Corrections

1. Spec §5 amended: the chain is 8 touch points (RecallService + types +
   picker were missing from the original "4").
2. Token gate: pointer Next lines trimmed to 120 chars (vs 200 in the MCP
   summary) to hold the section to ≈145 tokens worst-case.

## Gates (all observed this session)

- `npm run typecheck` clean.
- New: related-concepts unit (6), concept-injection (4), pointer-block +3,
  recall-over-http +2, hook pass-through +1 — M4 file set 85/85 with
  neighbors.
- Regression: M2 unit 42/42, M3 handler 9/9, contract 20/20 both lanes,
  tenant-guard + census green.

## For M5/M6

Recall path is complete end-to-end (daemon flag → wire → hook → block).
M5 (Thread strip) reads the same service data via the session-detail path;
M6 owns eval + changelog + rollout.
