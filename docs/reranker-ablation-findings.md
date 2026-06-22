# Reranker ablation — findings

Run it: `npm run eval:reranker` (reads `~/.nlm/hook-log.jsonl` + `citation-log.jsonl`; no corpus replay).

## What it measures

Does the citation-frequency reranker (`src/core/recall/reranker.ts`, live in
`recall-service.ts`) rank explicitly-cited sessions higher than raw recall does?

The hook-log already captured the real production candidate sets with base
scores, so the harness is purely offline. For each hook fire whose conversation
contains a `tool_use`-cited session present in that fire's candidate hits, it
compares the cited session's rank in raw-score order vs. after the production
`applyBoosts`. Boosts are built **leave-one-conversation-out** — the conversation
under test contributes no boost to itself — so we measure whether *prior*
citations help *future* recall, not the circular "does a session's own citation
lift it."

## Baseline result (first run, ~365d of logs)

| metric | base | reranked | delta |
|--------|------|----------|-------|
| MRR    | 0.623 | 0.623   | +0.001 |
| R@1    | 41.1% | 41.1%   | +0.0pp |
| R@3    | 82.8% | 82.1%   | -0.7pp |
| R@5    | 100%  | 100%    | +0.0pp |

151 samples: **1 improved, 1 hurt, 149 unchanged.**

## Conclusion

**The reranker is inert in production, and the cause is a score-scale mismatch.**
The production hook fires **keyword mode** (raw FTS5/BM25 scores: median ~12,
p75 ~28, max ~1200). The citation boost is `0.15·ln(1+count)` — typically
0.10–0.21, at most ~0.99. A sub-1.0 additive boost on scores of 12–1200 cannot
reorder anything but exact ties. The boost was calibrated for normalized 0..1
scores (hybrid/RRF), not the raw keyword path the hook actually uses. This is the
same raw-vs-normalized calibration issue tracked in #284.

Ranking headroom **does** exist (R@1 41%, R@5 100% — positives are in the
candidate set but not at the top), so a reranker that actually fires could help.

## Implications for #185 (neural reranker fine-tune)

A neural fine-tune is premature. Before investing in it:

1. **Fix the scale mismatch (Tier 2, ties into #284):** make the boost
   multiplicative (`score·(1+boost)`) or normalize keyword scores before
   boosting, then re-run this harness. A correctly-scaled *heuristic* reranker
   may capture the R@1 headroom for near-zero cost.
2. **Grow trainable labels:** 379 of 809 `tool_use` citations are orphaned under
   the `mcp_tool`/`unknown` conversation placeholder and unusable for both this
   eval and any training set. Thread the real `conversation_id` through
   `cite_session` going forward (the tool already accepts it).
3. Only then re-evaluate whether a neural reranker beats the tuned heuristic on
   this harness.
