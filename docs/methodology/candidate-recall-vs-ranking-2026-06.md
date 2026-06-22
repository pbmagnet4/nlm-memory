# candidate-recall vs ranking — residual-miss diagnosis (2026-06)

## Question

When recall fails to surface the gold session in the top-k, is it because the gold
session never entered candidate generation (a **candidate-recall miss** — the retrieval
floor is too tight), or because it entered the candidate pool but was ranked below the
top-k cut (a **ranking miss** — the ordering is wrong)? The two have different fixes:
candidate-recall misses need wider/better candidate generation (e.g. query expansion);
ranking misses need a better reranker over the existing pool.

## Method

A pure classifier (`scripts/eval/candidate-recall-classify.ts`: `classifyMiss` +
`aggregateClasses`) labels each query as `hit`, `ranking-miss`, or `candidate-miss`.
For each query the diagnostic runner (`scripts/eval/candidate-recall-diagnostic.ts`)
computes:

- the **final ranked top-k** via `RecallService.search(...)`, and
- a **wide raw candidate pull** = the union of `store.keywordSearch(query, N)` and
  `store.semanticSearch(embed(query), N)` at `N = wide`. This mirrors `RecallService`
  step 1 — the exact set assembled before `finalize()` ranks and slices — pulled at a
  deeper `N`.

Classification:
- `ranking-miss` = gold is in the wide pool but absent from the final top-k.
- `candidate-miss` = gold is absent from the wide pool entirely.

The candidate/ranking dichotomy maps 1:1 onto what a reranker can vs cannot fix: a
reranker reorders the candidate pool, so it can recover ranking misses but never
candidate misses. Shares are computed over **misses only** (hits excluded from the
denominator) since the question is *why* recall fails. In `aggregateClasses` a class
owns the verdict at ≥65% of misses, else the verdict is `mixed`.

Evaluated against the committed golden corpus (`tests/fixtures/golden-corpus.ts`) and
the locally-cached LongMemEval-S, stratified across `question_type`. The diagnostic
requires no live model: it reads the on-disk LongMemEval embedding cache and degrades
the semantic leg to keyword-only on any cache miss, so it is reproducible offline. All
writes go to disposable temp DBs; the operator store is never touched.

## Result

| metric | value |
|---|---|
| LongMemEval-S instances evaluated (stratified, wide=50, k=5) | 280 |
| hits / ranking-miss / candidate-miss (wide=50) | 268 / 12 / 0 |
| ranking-miss share of all misses (wide=50) | 100.0% (12/12) |
| candidate-miss share of all misses (wide=50) | 0.0% (0/12) |
| robustness re-run (wide=20, k=5, 260 instances) | 248 hits / 12 ranking-miss / 0 candidate-miss → still 100% ranking |
| golden corpus (keyword, k=5) | n=6, 6 hits, 0 misses (no split; all surface in top-5) |

**Verdict: ranking-bound.** Of the residual misses, 100% are ranking misses (gold is in
the wide candidate pool but ranked below the top-k cut) and 0% are candidate-recall
misses. The split is robust at both `wide=50` and `wide=20`, so it is not an artifact of
the pool engulfing the whole haystack. The golden corpus has zero misses at k=5, so it
contributes no split — it acts as a regression gate, not a miss source.

LongMemEval-S baseline is ~97% R@5, so misses are sparse; a 280-instance stratified
sample surfaced 12 misses — enough for an unambiguous 100/0 split but a modest absolute
count. The `wide=20` vs `wide=50` agreement establishes the conclusion is stable
regardless of pool depth.

## Implication

A **reranker over the existing candidate set is the correct lever** for the residual
misses. Query expansion would not help: the gold session already enters candidate
generation in every observed miss, so widening generation recovers nothing. The
surfaces a reranker would strengthen already exist —
`src/core/recall/reranker.ts` (citation-frequency reranker) and
`src/core/recall/metadata-tiebreaker.ts`.

## Status: gated, not built here

Building the reranker improvement is **NLM task #185** and is **Tier 2** — it changes
recall output and therefore requires per-action approval and a proven net-positive
result (precision up, recall flat) on the golden set before defaulting on. It is **not
implemented in this work**. This document records the diagnosis and justifies the lever;
the implementation is deferred to its own gated change.

## Data that must accrue before the reranker is worth building

The candidate-frequency reranker improves only with supervision signal that does not yet
exist at volume:

- **Citation labels** — `~/.nlm/citation-log.jsonl` rows joining surfaced sessions to
  the ones the agent actually cited. These are the positive labels that tell the reranker
  which candidate *should* have ranked first. (See `docs/methodology/useful-hit-rate.md`
  for how citation capture is derived.)
- **Edit-distance / supersedence labels** — signal distinguishing the live session from
  superseded near-duplicates, so the reranker learns to demote stale candidates rather
  than the wrong fresh one.

Until both accrue at sufficient volume, a reranker change cannot be proven net-positive
on the golden set and should not be defaulted on.
