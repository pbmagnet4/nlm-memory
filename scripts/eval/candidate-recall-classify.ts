/**
 * Pure classification logic for the candidate-recall diagnostic.
 *
 * The diagnostic answers one question for every residual recall miss: is the
 * gold session/fact absent from a *wide* candidate pull (so no reranker can
 * recover it and query expansion is the only lever) or is it present in the
 * candidate set but ranked below the final top-k cut (so a reranker would
 * help)?
 *
 *  - hit             : a gold id appears in the final ranked top-k.
 *  - ranking-miss    : no gold id in the final top-k, but a gold id IS in the
 *                      wide candidate pool. A reranker can fix this.
 *  - candidate-miss  : no gold id anywhere in the wide candidate pool. A
 *                      reranker cannot help; query expansion / recall is needed.
 *
 * Deterministic and dependency-free so it can be unit-tested with synthetic
 * inputs, mirroring scripts/longmemeval/scorer.ts.
 */

export type MissClass = "hit" | "ranking-miss" | "candidate-miss";

export interface ClassifyInputs {
  readonly goldIds: ReadonlyArray<string>;
  /** Final ranked result ids, top-k (already sliced to the eval k). */
  readonly finalTopKIds: ReadonlyArray<string>;
  /** Wide raw candidate pool ids (union of keyword + semantic legs, top-N). */
  readonly wideCandidateIds: ReadonlyArray<string>;
}

export function classifyMiss(input: ClassifyInputs): MissClass {
  const gold = new Set(input.goldIds);
  if (gold.size === 0) return "candidate-miss";

  const inFinal = input.finalTopKIds.some((id) => gold.has(id));
  if (inFinal) return "hit";

  const inWide = input.wideCandidateIds.some((id) => gold.has(id));
  return inWide ? "ranking-miss" : "candidate-miss";
}

export interface DiagnosticAggregate {
  readonly n: number;
  readonly hits: number;
  readonly rankingMisses: number;
  readonly candidateMisses: number;
  /** Of the MISSES only (n - hits): fraction that are ranking vs candidate. */
  readonly rankingMissShare: number;
  readonly candidateMissShare: number;
  readonly verdict: "recall-bound" | "ranking-bound" | "mixed" | "no-misses";
}

/**
 * Aggregate per-query classifications. Shares are computed over the misses
 * only (the denominator excludes hits), since the verdict is about *why*
 * recall fails, not the overall hit rate.
 *
 * Verdict thresholds: a class owns the verdict when it is at least 65% of all
 * misses; otherwise the split is "mixed".
 */
export function aggregateClasses(
  classes: ReadonlyArray<MissClass>,
): DiagnosticAggregate {
  const n = classes.length;
  let hits = 0;
  let rankingMisses = 0;
  let candidateMisses = 0;
  for (const c of classes) {
    if (c === "hit") hits++;
    else if (c === "ranking-miss") rankingMisses++;
    else candidateMisses++;
  }
  const misses = rankingMisses + candidateMisses;
  if (misses === 0) {
    return {
      n,
      hits,
      rankingMisses,
      candidateMisses,
      rankingMissShare: 0,
      candidateMissShare: 0,
      verdict: "no-misses",
    };
  }
  const rankingMissShare = round3(rankingMisses / misses);
  const candidateMissShare = round3(candidateMisses / misses);
  let verdict: DiagnosticAggregate["verdict"];
  if (candidateMissShare >= 0.65) verdict = "recall-bound";
  else if (rankingMissShare >= 0.65) verdict = "ranking-bound";
  else verdict = "mixed";
  return {
    n,
    hits,
    rankingMisses,
    candidateMisses,
    rankingMissShare,
    candidateMissShare,
    verdict,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
