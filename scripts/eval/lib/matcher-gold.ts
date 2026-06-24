import { readFileSync } from "node:fs";

export interface GoldMatch { key: string; sessionId: string; label: string; summary: string; goldWorkstream: string; }
export interface Prediction { goldWorkstream: string; predicted: string | null; score: number; }
export interface MatcherMetrics { total: number; binds: number; correct: number; precision: number; recall: number; }

export function loadGold(path: string): GoldMatch[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as GoldMatch);
}

export function scoreGold(preds: ReadonlyArray<Prediction>): MatcherMetrics {
  const total = preds.length;
  const binds = preds.filter((p) => p.predicted !== null).length;
  const correct = preds.filter((p) => p.predicted !== null && p.predicted === p.goldWorkstream).length;
  return { total, binds, correct, precision: binds === 0 ? 0 : correct / binds, recall: total === 0 ? 0 : correct / total };
}

/** Sweep candidate HIGH cuts over the observed score grid; pick the highest cut whose
 *  retained correct-bind recall stays >= minRecall. LOW is set a band below HIGH. */
export function sweepThresholds(scored: ReadonlyArray<Prediction>, minRecall: number): { high: number; low: number; recall: number; precision: number } {
  const grid = [...new Set(scored.map((p) => p.score))].sort((a, b) => a - b);
  const totalGold = scored.length || 1;
  let best = { high: 0, low: 0, recall: 0, precision: 0 };
  for (const t of grid) {
    const kept = scored.filter((p) => p.score >= t);
    const correct = kept.filter((p) => p.predicted === p.goldWorkstream).length;
    const recall = correct / totalGold;
    const precision = kept.length === 0 ? 0 : correct / kept.length;
    if (recall >= minRecall && t >= best.high) best = { high: t, low: Math.max(0, t - 0.2), recall, precision };
  }
  return best;
}
