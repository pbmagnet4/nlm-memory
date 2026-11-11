/**
 * Deterministic scoring helpers for the T1612 live-corpus wiki ablation
 * (scripts/eval/wiki-live-ablation.ts). Pure functions, no IO, no models —
 * unit-tested with synthetic data in tests/unit/scripts/wiki-live-scoring.test.ts.
 *
 * Blend contract (declared upfront, not tuned): a wiki+search candidate
 * scores 0.5 * normalized recall score + 0.5 * wiki-page token recall.
 * WIKI_BLEND is the single fixed weight shared by both terms.
 */

export const WIKI_BLEND = 0.5;

/** Lowercase alnum tokens of length > 1 (same shape as the spike scorer). */
export function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1));
}

/** Fraction of query tokens present in the document token set. */
export function tokenRecall(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const t of query) if (doc.has(t)) hit += 1;
  return hit / query.size;
}

/**
 * Min-max normalize a candidate score list to [0, 1], preserving order.
 * A degenerate (all-equal) list maps to all 1s so the blend falls back to
 * the wiki term instead of zeroing every candidate.
 */
export function normalizeScores(scores: ReadonlyArray<number>): number[] {
  if (scores.length === 0) return [];
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  if (hi <= lo) return scores.map(() => 1);
  return scores.map((s) => (s - lo) / (hi - lo));
}

export interface BlendCandidate {
  readonly id: string;
  /** Raw recall-path score (e.g. RecallHit.matchScore). */
  readonly score: number;
  /** Wiki-page token recall for this candidate's workstream (0 when none). */
  readonly wikiRecall: number;
  /** Original rank from the recall path (0-based); stable tie-break. */
  readonly rank: number;
}

/**
 * Re-rank recall-path candidates by the fixed 50/50 blend. Returns ids
 * sorted best-first; ties break by original recall rank (deterministic).
 */
export function blendedRerank(candidates: ReadonlyArray<BlendCandidate>): string[] {
  const norm = normalizeScores(candidates.map((c) => c.score));
  return candidates
    .map((c, i) => ({
      id: c.id,
      blended: WIKI_BLEND * norm[i]! + WIKI_BLEND * c.wikiRecall,
      rank: c.rank,
    }))
    .sort((a, b) => b.blended - a.blended || a.rank - b.rank)
    .map((c) => c.id);
}

/**
 * Mean recall@K over the labeled ids: |labeled ∩ topK| / |labeled|.
 * Partial credit per question; the eval averages this across questions.
 */
export function recallAtK(labeledIds: ReadonlyArray<string>, topKIds: ReadonlyArray<string>): number {
  if (labeledIds.length === 0) return 0;
  const top = new Set(topKIds);
  let hit = 0;
  for (const id of labeledIds) if (top.has(id)) hit += 1;
  return hit / labeledIds.length;
}
