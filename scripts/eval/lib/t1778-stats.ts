/**
 * T1778 E1/E3 helper — shared AUC / operating-point maths for the T1778 reports.
 *
 * Every gate here is "skip (or drop) below the threshold", so the operating
 * point is reported as: fraction removed, fraction of positives kept, and the
 * Wilson lower bound on that kept fraction.
 */
export function auc(rows: ReadonlyArray<{ score: number; positive: boolean }>): number {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  if (!pos.length || !neg.length) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

/**
 * Highest threshold whose measured positive retention is at least `minKeep`.
 * Candidates are the observed scores, so the reported threshold is reproducible.
 */
export function thresholdForKeep(rows: ReadonlyArray<{ score: number; positive: boolean }>, minKeep: number): number {
  const pos = rows.filter((r) => r.positive).map((r) => r.score).sort((a, b) => a - b);
  if (!pos.length) return 0;
  const cands = [...new Set(rows.map((r) => r.score))].sort((a, b) => a - b);
  let best = cands[0] ?? 0;
  for (const t of cands) {
    const kept = pos.filter((s) => s >= t).length / pos.length;
    if (kept >= minKeep) best = t;
    else break;
  }
  return best;
}

export function rate(n: number, d: number): string {
  return `${((100 * n) / Math.max(d, 1)).toFixed(1)}%`;
}

export function spearman(pairs: ReadonlyArray<[number, number]>): number {
  const rank = (xs: number[]): number[] => {
    const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(xs.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      const avg = (i + j + 2) / 2;
      for (let k = i; k <= j; k++) out[idx[k]![1]!] = avg;
      i = j + 1;
    }
    return out;
  };
  const a = rank(pairs.map((p) => p[0]));
  const b = rank(pairs.map((p) => p[1]));
  const n = pairs.length;
  if (n < 3) return Number.NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : Number.NaN;
}
