/**
 * Selects which recall hits the hook surfaces. Pure — no I/O.
 *
 * Order of filtering: score threshold, then dedup against ids already
 * surfaced in this conversation, then the per-fire cap bounded by the
 * remaining per-conversation budget. Hits are assumed pre-ranked best-first.
 */

export interface RecallHitInput {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly matchScore: number;
  readonly summary?: string;
}

export interface SelectParams {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly surfaced: ReadonlySet<string>;
  readonly scoreThreshold: number;
  readonly perFireCap: number;
  readonly perConversationCap: number;
  /**
   * Drop tail hits scoring below this fraction of the fire's median score (0 =
   * off). Scale-invariant — a ratio — so it works on raw BM25 or normalized
   * scores and ports across installs unchanged. The top hit (>= median) always
   * survives, so this trims weak tail hits; it does not suppress an off-topic
   * fire. Calibrated via scripts/eval/floor-calibration.ts (#284).
   */
  readonly relativeFloor?: number;
}

function medianScore(hits: ReadonlyArray<RecallHitInput>): number {
  if (hits.length === 0) return 0;
  const sorted = hits.map((h) => h.matchScore).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function selectHits(params: SelectParams): ReadonlyArray<RecallHitInput> {
  const { hits, surfaced, scoreThreshold, perFireCap, perConversationCap, relativeFloor = 0 } = params;
  const relCut = relativeFloor > 0 ? relativeFloor * medianScore(hits) : 0;
  const eligible = hits.filter(
    (h) => h.matchScore >= scoreThreshold && h.matchScore >= relCut && !surfaced.has(h.id),
  );
  const budget = Math.max(0, perConversationCap - surfaced.size);
  const limit = Math.min(perFireCap, budget);
  return eligible.slice(0, limit);
}
