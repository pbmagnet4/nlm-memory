# T527 — Re-measure the fact corroboration boost cap

## Why

T504 found `NLM_FACT_CORROBORATION_BOOST_CAP` (default 2.0) wrecking fact recall:
with the **nomic** hybrid and natural-language queries, R@1 was 27% at the
default boost vs 81% at cap=1. Two things have changed since: the embedder is
now `text-embedding-embeddinggemma-2-oQ8e` (768d, re-embedded 2026-10-23; see
the `embedding_config` table) and T1036 added a BM25 keyword leg + RRF fusion.
This re-measures before touching the default.

## Method

Read-only copy of the live corpus (`sqlite3 ~/.nlm/canonical.sqlite ".backup"` →
`.eval/canonical.sqlite`, deleted after the run), scored through the real
`FactRecallService` path by

```
npx tsx scripts/eval/fact-recall-eval.ts --db=.eval/canonical.sqlite \
  --limit=300 --gold=topic,paraphrase \
  --boost-caps=default,1,1.25,1.5 --modes=semantic,hybrid,keyword
```

Corpus at copy time: 86,298 `team_local` facts; recall pool = 11,175 current
decision facts (kind=decision, confidence ≥ 0.6, not superseded/retired);
300 stride-sampled gold facts. `topic` gold = subject+predicate with the value
held out; `paraphrase` gold = LLM-framed natural questions (the arm closest to
production traffic), 300/300 generated via the classifier lane. Every
cap × mode × gold arm scores all 300 queries against the same fact vectors
(`--boost-caps` re-scores the same embeddings; only the env-capped boost
changes). Raw output: the eval stderr table, mirrored below.

## Results (n=300 per arm)

| gold | cap | mode | R@1 | R@3 | R@5 | found | meanRank |
|---|---|---|---:|---:|---:|---:|---:|
| topic | default (2.0) | semantic | 1.7% | 11.7% | 33.0% | 282 | 9.25 |
| topic | default (2.0) | hybrid | **27.3%** | 68.0% | 84.3% | 289 | 2.98 |
| topic | default (2.0) | keyword | 74.3% | 86.7% | 93.0% | 298 | 2.20 |
| topic | 1 | semantic | 59.3% | 75.0% | 78.7% | 283 | 4.20 |
| topic | 1 | hybrid | **84.0%** | 94.0% | 95.0% | 289 | 1.25 |
| topic | 1 | keyword | 76.0% | 87.0% | 93.0% | 298 | 2.14 |
| topic | 1.25 | semantic | 3.0% | 13.0% | 33.7% | 281 | 9.15 |
| topic | 1.25 | hybrid | 79.0% | 91.7% | 95.0% | 289 | 1.38 |
| topic | 1.25 | keyword | 74.3% | 86.7% | 93.0% | 298 | 2.20 |
| topic | 1.5 | semantic | 2.0% | 11.7% | 33.0% | 281 | 9.23 |
| topic | 1.5 | hybrid | 36.7% | 77.3% | 89.7% | 289 | 2.47 |
| topic | 1.5 | keyword | 74.3% | 86.7% | 93.0% | 298 | 2.20 |
| paraphrase | default (2.0) | semantic | 4.3% | 22.3% | 46.7% | 292 | 7.03 |
| paraphrase | default (2.0) | hybrid | **22.7%** | 54.3% | 68.7% | 296 | 5.18 |
| paraphrase | default (2.0) | keyword | 18.0% | 24.7% | 26.3% | 166 | 15.14 |
| paraphrase | 1 | semantic | 78.0% | 88.3% | 91.0% | 292 | 2.08 |
| paraphrase | 1 | hybrid | **65.3%** | 78.7% | 83.7% | 296 | 2.95 |
| paraphrase | 1 | keyword | 18.0% | 25.0% | 26.0% | 165 | 15.46 |
| paraphrase | 1.25 | semantic | 5.7% | 23.0% | 46.7% | 292 | 7.00 |
| paraphrase | 1.25 | hybrid | 52.0% | 71.0% | 78.7% | 296 | 3.81 |
| paraphrase | 1.25 | keyword | 18.0% | 24.7% | 26.0% | 165 | 15.22 |
| paraphrase | 1.5 | semantic | 4.7% | 22.7% | 46.7% | 292 | 7.02 |
| paraphrase | 1.5 | hybrid | 28.0% | 59.3% | 70.7% | 296 | 4.89 |
| paraphrase | 1.5 | keyword | 18.0% | 24.7% | 26.0% | 166 | 15.24 |

A rerun of the four hybrid arms (topic gold) reproduced every number exactly —
the arms are deterministic, and the non-monotonic 1.25-vs-1.5 hybrid cliff is
real: the log-scale factor for count=2 is 1+log10(2)=1.301, so cap 1.25
clips it but cap 1.5 does not, and corroborated-distractor/gold score ratios
sit densely in that band (see interpretation).

## Interpretation

- T504's result **replicates on the new stack.** Hybrid natural-language
  (paraphrase) R@1 at the default cap: 22.7% now vs 27% then; at cap=1 it is
  65.3% now vs 81% then. The embedder change and the BM25+RRF leg did not fix
  the boost damage; the `default → cap=1` gap is +42.6 pts (paraphrase) /
  +56.7 pts (topic) hybrid R@1.
- The damage is multiplicative-onto-cosine, not coverage: only 142/11,175
  pool facts (1.3%) have corroboration ≥ 2, but a 1.3–2.0× multiplier on
  cosine scores compressed in ~0.5–0.75 lets any 2-session corroborated
  distractor vault over many uncorroborated facts. Semantic mode is hit
  hardest (R@1 1.7–5.7% at caps ≥ 1.25 vs 59.3–78.0% at cap=1); keyword/BM25
  scores spread widely enough that the boost only costs ~1–2 pts there.
- Hybrid at cap=1 remains the best overall configuration and still beats
  keyword alone everywhere (topic 84 vs 76; paraphrase 65.3 vs 18), so the
  semantic leg and RRF are earning their keep once the boost stops stacking
  on top.

## Part 2 — are corroborated facts actually more cited?

The premise cannot be measured directly: **there are no cite tables in the
canonical database and fact-citation telemetry is empty.** Fact-level citation
would land in the citation log via `cite_session`, the Stop-hook detector
(tool-use/prose substring scan over surfaced ids), or `get_fact_history`
follow-ups — none produced a single fact id. Concretely, joined against the
copy:

- `~/.nlm/fact_query_log.jsonl`: 35,997 recall_facts calls, 195,361 returned-id
  occurrences, **3,288 distinct facts surfaced** — but only 97 lines carry a
  `conversation_id` (75 distinct conversations).
- `~/.nlm/citation-log.jsonl` (all history + the 2026-08-18 rotation): 262
  lines, 197 distinct cited ids, **zero `fact_*`-shaped citations** — every
  citation resolves to a session (cc_*/muse/pi/codex/…). 16 of the 75
  fact-query conversations have any citation, all session-level.
- Hook useful-hit scan (`useful-hit-log.jsonl`, 176 rows): zero fact ids in
  any returned set.

So the closest computable use proxies, bucketed by corroboration count
(COUNT(DISTINCT source_session_id) over the same (subject, predicate, value,
property) — exactly what `applyCorroboration` multiplies by), over the
11,175-fact recall pool in the copy:

| corroboration bucket | facts | % of pool | surfaced by recall_facts | source session later cited | both | max count |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 11,033 | 98.7% | 307 (2.8%) | 373 (3.4%) | 23 | 1 |
| 2 | 93 | 0.83% | 9 (9.7%) | 2 (2.2%) | 1 | 2 |
| 3+ | 49 | 0.44% | 1 (2.0%) | 0 (0.0%) | 0 | 49 |

Read-outs:

1. The boost is aiming at 1.3% of the pool. Whatever it does, it cannot help
   the other 98.7% — it can only demote them.
2. Corroborated facts are **not** more cited on either proxy: cited-source
   rate falls 3.4% → 2.2% → 0% as corroboration rises (small n in the 2/3+
   rows, but directionally flat-to-negative, never positive).
3. Of the 24 surfaced facts whose source session was later cited, 23 carry
   corroboration count 1 — the signal "this fact is corroborated" adds
 nothing to the observed use signal.

Conclusion: there is no usage evidence that corroboration predicts
usefulness — only the ranking damage measured above. The count remains worth
*reporting* on hits (it is context for the caller), just not worth ranking on.
