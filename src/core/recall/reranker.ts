/**
 * Citation-frequency reranker. Sessions cited frequently in past
 * conversations receive a small log-scaled score boost on top of FTS5/RRF
 * scores.
 *
 * Boost formula: ALPHA * log(1 + count), where count is citation frequency.
 * ALPHA=0.15 is a conservative dampening to preserve the baseline FTS5 ranking
 * while letting high-frequency citations gently percolate up.
 *
 * Constraint: zero-score results (non-matches) are never promoted above
 * non-zero FTS5 hits, preserving the semantic guarantee that a hit that
 * matched the query (even weakly) stays ranked above one that didn't match.
 */

import type { CitationEntry } from "./citation-log.js";

export type CitationBoostMap = Map<string, number>;

const ALPHA = 0.15;

/**
 * Build a boost map from citation frequency. Sessions cited N times receive
 * a boost of ALPHA * log(1 + N).
 */
export function buildCitationBoosts(
  citations: ReadonlyArray<CitationEntry>,
): CitationBoostMap {
  const counts = new Map<string, number>();
  for (const c of citations) {
    counts.set(c.citedId, (counts.get(c.citedId) ?? 0) + 1);
  }

  const boosts: CitationBoostMap = new Map();
  for (const [id, count] of counts) {
    boosts.set(id, ALPHA * Math.log(1 + count));
  }

  return boosts;
}

/**
 * Apply boosts to results, resorting by adjusted matchScore.
 *
 * Constraint: a zero-score result can never be promoted above a non-zero one,
 * preserving the semantic guarantee that non-matches stay below matches.
 *
 * Returns a new array sorted by adjusted matchScore (descending).
 *
 * Generic over result type T, expecting { id: string; matchScore: number }.
 */
export function applyBoosts<T extends { id: string; matchScore: number }>(
  results: ReadonlyArray<T>,
  boosts: CitationBoostMap,
): T[] {
  if (boosts.size === 0) return [...results];

  const boosted = results.map((r) => {
    if (r.matchScore === 0) return r;
    const boost = boosts.get(r.id) ?? 0;
    return { ...r, matchScore: r.matchScore + boost };
  });

  return boosted.sort((a, b) => b.matchScore - a.matchScore);
}
