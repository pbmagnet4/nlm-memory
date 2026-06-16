# Fact-recall coverage — NLM #277

**Date:** 2026-06-16
**Goal:** Establish the first `recall_facts` quality baseline (no fact-recall
benchmark existed — the #307/#308 work was session-recall only), then fix what
it surfaced.

## Harness

`scripts/eval/fact-recall-eval.ts` (committed, reusable). Drives the REAL
`FactRecallService` — the same code path the `recall_facts` MCP tool uses — over
a sandbox copy of production `canonical.sqlite`. The live `~/.nlm` DB is never
opened.

**Gold set (deterministic, no LLM):** each current `decision` fact's
`(subject, predicate)` is unique among current facts (supersedence collapses
collisions), so a query framed from `subject + predicate` has exactly ONE
correct answer with the `value` (the answer) held out. Well-posed retrieval:
"given a topic, does the right decision rank top-k among 7,486 current facts."
80 facts stride-sampled across the 1,603-fact current-decision pool.

**Methodology caveat:** topic queries (`subject predicate`) favour semantic
recall because the fact's embedding includes that text. A natural-language
paraphrase gold set (LLM-framed questions) is a harder future arm. The
*coverage* finding below is mode-independent and unaffected by this.

## Baseline (before fix)

| Mode | R@1 | R@3 | R@5 | found | mean rank (found) |
|------|-----|-----|-----|-------|-------------------|
| keyword | 3.8% | 7.5% | 8.8% | 12/80 | 4.58 |
| semantic | 7.5% | 15% | 15% | 12/80 | 1.58 |
| hybrid | 7.5% | 12.5% | 12.5% | 12/80 | 2.42 |

**`found 12/80` is the smoking gun:** for 68 of 80 queries the gold fact was not
returned at *any* rank (probe depth 50).

## Root cause

`FactStore.listForRecall` runs `ORDER BY created_at DESC LIMIT 500`
(`STORAGE_FETCH_CAP`). With 7,486 current facts, a free-text query (no
subject/predicate filter) only ever sees the **500 most-recent facts**. Worse:
the semantic leg searched the full vector index but then dropped every neighbour
not present in that recency window (`byId.get(n.factId)` → `continue`), so
semantic recall — which should be corpus-wide — was silently capped to recent
facts too. **~93% of the corpus was unreachable by `recall_facts`.**

When a fact *was* in-window, semantic ranked it well (mean rank 1.58). The
problem was reachability, not ranking.

## Fix

Decouple semantic recall from the keyword candidate window
(`src/core/recall-facts/fact-recall-service.ts`):

- New `FactStore.getByIds(ids)` batch lookup (sqlite + pg adapters).
- `runSemantic` resolves vector neighbours outside the keyword window via
  `getByIds`, then re-applies the same filters the SQL pre-filter would have
  (`makeFilterPredicate`: superseded / minConfidence / kind / subject /
  predicate). The keyword leg stays recency-windowed (a reasonable BM25
  candidate strategy); semantic + hybrid now reach the whole corpus.
- `mergeHybrid` resolves facts from the hits themselves, so semantic-only facts
  outside the window survive the merge.

## After fix

| Mode | R@1 | R@3 | R@5 | found | mean rank (found) |
|------|-----|-----|-----|-------|-------------------|
| keyword | 3.8% | 7.5% | 8.8% | 12/80 | 4.58 |
| **semantic** | **57.5%** | **91.3%** | **98.8%** | **80/80** | 1.81 |
| **hybrid** | 47.5% | 72.5% | 87.5% | 80/80 | 2.7 |

Semantic R@5 15% → **98.8%**; all 80 facts now reachable. Keyword unchanged
(still windowed — expected; keyword-only is the degraded fallback mode).

## Part 2 — semantic-primary hybrid (default-mode fix)

The coverage fix surfaced a second problem: post-fix, **pure semantic beat
hybrid** — and hybrid is the MCP default. The equal-weight blend
(`0.6·sem + 0.4·kw`) let high keyword scores on recent-but-wrong facts dilute
strong semantic hits.

**Why facts differ from sessions:** the #307/#308 session-recall work found
keyword/BM25 is the *strong* leg and RRF/semantic blends regressed. Facts invert
this — they are short `(subject, predicate, value)` triples, so keyword has few
tokens to match and semantic over the fact embedding dominates. The right blend
is therefore domain-specific.

**Fix:** `mergeHybrid` is now **semantic-primary** — semantic hits occupy the
upper score band `[0.5, 1.0]` (ranked by similarity); keyword-only hits (facts
semantic never surfaced) backfill `[0, 0.5)`. Co-occurrence is not rewarded
(that was the dilution source). When the embedder is down, `semHits` is empty
and hybrid degrades to pure keyword — the graceful-degradation contract holds.

### Hybrid before vs after the merge fix

| Gold set | metric | weighted blend | semantic-primary | pure semantic (ref) |
|----------|--------|----------------|------------------|---------------------|
| paraphrase | R@5 | 73.8% | **85.0%** | 87.5% |
| paraphrase | R@1 | 26.3% | **36.3%** | 48.8% |
| topic | R@5 | 87.5% | **92.5%** | 98.8% |
| topic | R@1 | 47.5% | **47.5%** | 57.5% |

Hybrid (the default) now tracks semantic closely and keeps the keyword fallback.

**Residual gap (documented, not chased):** hybrid R@1 still trails semantic
because `applyCorroboration` multiplies matchScore by up to 2×, which can lift a
highly-corroborated keyword-only backfill across the 0.5 band boundary and ahead
of the correct semantic top hit. Eliminating it means banding *after* the
corroboration boost rather than before. Low value vs complexity at current
quality; left as a future refinement.

## Gold sets

- **topic** (`--gold=topic`, default): query = `subject predicate`, value held
  out. Deterministic, no LLM. Favours semantic.
- **paraphrase** (`--gold=paraphrase`): an LLM (qwen3.5:4b) writes the natural
  question a user would ask, value held out. Harder, realistic. Cached at
  `~/.cache/nlm-fact-recall/paraphrase-gold.jsonl` (gitignored — may contain
  project/client names).

## Reproduce

```
npx tsx scripts/eval/fact-recall-eval.ts --gold=topic --limit=80 --probe=50
npx tsx scripts/eval/fact-recall-eval.ts --gold=paraphrase --limit=80 --probe=50
```
