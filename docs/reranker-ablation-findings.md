# Reranker ablation — findings

Run it: `npm run eval:reranker` (reads `~/.nlm/hook-log.jsonl` + `citation-log.jsonl`; no corpus replay).

## What it measures

Does the citation-frequency reranker (`src/core/recall/reranker.ts`) rank
explicitly-cited sessions higher than raw recall does? (It was wired into
`recall-service.ts` until this change; the ablation below is why it was removed.)

The hook-log already captured the real production candidate sets with base
scores, so the harness is purely offline. For each hook fire whose conversation
contains a `tool_use`-cited session present in that fire's candidate hits, it
compares the cited session's rank in raw-score order vs. after the production
`applyBoosts`. Boosts are built **leave-one-conversation-out** — the conversation
under test contributes no boost to itself — so we measure whether *prior*
citations help *future* recall, not the circular "does a session's own citation
lift it."

## Step 1 — baseline, raw scores (the bug)

With the production hook firing **keyword mode** (raw FTS5/BM25 scores: median
~12, p75 ~28, max ~1200) and the citation boost at `0.15·ln(1+count)` (typically
0.10–0.21, max ~0.99):

| metric | base | reranked | delta |
|--------|------|----------|-------|
| MRR    | 0.623 | 0.623   | +0.001 |
| R@1    | 41.1% | 41.1%   | +0.0pp |

151 samples: **1 improved, 1 hurt, 149 unchanged.** A sub-1.0 additive boost on
scores of 12–1200 can't reorder anything but exact ties — the reranker is inert.
Same raw-vs-normalized issue as #284.

## Step 2 — normalize keyword scores to 0..1, then sweep the boost weight

Normalizing keyword scores by their set max (matching `mergeHybrid`) makes the
boost *bite*. But the citation-frequency signal then proves **net-negative at
every weight** — there is no alpha where it helps:

| alpha | MRR | ΔMRR | R@1 | ΔR@1 | improved/hurt |
|-------|-----|------|-----|------|---------------|
| 0.00 (off) | 0.623 | — | 41.1% | — | 0/0 |
| 0.01  | 0.623 | +0.000 | 41.1% | +0.0pp | 1/2 |
| 0.02  | 0.622 | -0.001 | 40.4% | -0.7pp | 4/3 |
| 0.05  | 0.610 | -0.013 | 38.4% | -2.6pp | 10/12 |
| 0.15  | 0.605 | -0.018 | 38.4% | -2.6pp | 15/24 |

Run the sweep: `npm run eval:reranker`. Single weight: `--alpha 0.05`.

## Conclusion

**Citation frequency is not a per-query relevance signal on this corpus.** A
globally-popular session (cited often in other conversations) is not the right
answer to *this* query, so boosting by it displaces the genuinely-best keyword
match. The reranker was inert at the raw FTS5 scale (boost swamped) and actively
harmful once normalized. **Decision: remove the citation boost from the recall
path.** `buildCitationBoosts`/`applyBoosts` stay as the harness's tested utility
and a hook for a future relevance-aware reranker.

The boost is the only change here. We deliberately do **not** normalize keyword
scores: with the reranker gone, normalization has no consumer that benefits, and
a separate analysis (see floor calibration below) showed min-max normalization
makes the score floor *worse*, not better. So keyword recall keeps its raw FTS5
scale.

Net effect on ranking today: **none** — the boost was inert at raw scale, so
removing it changes nothing functionally; it's a cleanup that deletes a
proven-dead feature.

## Implications for #185 (neural reranker fine-tune)

A neural fine-tune **on citation labels** is the wrong target: it would learn the
same non-predictive popularity signal this ablation just rejected. A useful
reranker needs a query↔document relevance signal (e.g. a cross-encoder over
query × session body), not citation frequency. If pursued later:

1. Train on query-relevance labels, not citation co-occurrence.
2. Validate against **this harness** (it already isolates the ranking-bound
   residual: R@5 is 100%, so all headroom is in getting the right session to
   rank 1, currently 41%).
3. Grow trainable labels regardless: 380 of 809 `tool_use` citations are orphaned
   under the `mcp_tool`/`unknown` conversation placeholder (see #345).
