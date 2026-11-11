const Z = 1.959964;

export function wilson(correct: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = correct / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** One-sided 95% upper bound on the true rate after zero errors in n trials. */
export function ruleOfThree(n: number): number | null {
  return n === 0 ? null : 3 / n;
}

export function cohenKappa(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length) throw new Error("kappa needs equally long label lists");
  const n = a.length;
  if (n === 0) return null;
  const categories = new Set([...a, ...b]);
  const observed = a.filter((x, i) => x === b[i]).length / n;
  let chance = 0;
  for (const c of categories) chance += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  return chance === 1 ? null : (observed - chance) / (1 - chance);
}

export interface StratumCount { readonly stratum: string; readonly population: number; readonly n: number; readonly correct: number }

/** Strata with population but no sampled units are dropped from the weights and named in `unsampled`. */
export function postStratified(strata: readonly StratumCount[]): { estimate: number | null; unsampled: string[] } {
  const sampled = strata.filter((s) => s.n > 0);
  const total = sampled.reduce((sum, s) => sum + s.population, 0);
  const unsampled = strata.filter((s) => s.n === 0 && s.population > 0).map((s) => s.stratum);
  if (total === 0) return { estimate: null, unsampled };
  return { estimate: sampled.reduce((sum, s) => sum + (s.population / total) * (s.correct / s.n), 0), unsampled };
}
