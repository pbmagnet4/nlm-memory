import { createHash } from "node:crypto";

export function splitOf(id: string): "tune" | "holdout" {
  const first = createHash("sha256").update(id).digest()[0] ?? 0;
  return first % 2 === 0 ? "tune" : "holdout";
}

export function sweep(
  rows: ReadonlyArray<{ score: number; positive: boolean }>,
  thresholds: ReadonlyArray<number>,
): { threshold: number; positiveKept: number; negativeSkipped: number }[] {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  return thresholds.map((threshold) => ({
    threshold,
    positiveKept: pos.length === 0 ? 1 : pos.filter((r) => r.score >= threshold).length / pos.length,
    negativeSkipped: neg.length === 0 ? 0 : neg.filter((r) => r.score < threshold).length / neg.length,
  }));
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

export function auc(rows: ReadonlyArray<{ score: number; positive: boolean }>): number {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function brier(rows: ReadonlyArray<{ p: number; y: boolean }>): number {
  return rows.reduce((s, r) => s + (r.p - (r.y ? 1 : 0)) ** 2, 0) / rows.length;
}
