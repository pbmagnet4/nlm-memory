/**
 * Disproportionate stratified sampling for Stage A.
 *
 * recall-impact-replay-lib's stratifiedSample allocates PROPORTIONAL to each
 * stratum's share of the pool. Stage A needs the opposite: rare strata (53
 * pairs at J' >= 0.35) are sampled near-exhaustively while the 257k-pair band
 * is sampled thinly, and the population sizes are carried separately so
 * scoring can weight back. Reusing the proportional sampler here would collapse
 * the whole design into "sample the big bands."
 *
 * The PRNG is the repo's audited one, not a second implementation.
 */

import { deriveSeed, makeRng, seededShuffle } from "./recall-impact-replay-lib.js";

export interface Shortfall {
  readonly stratum: string;
  readonly wanted: number;
  readonly available: number;
}

export interface AllocatedSampleResult<T> {
  readonly selected: ReadonlyArray<T>;
  readonly drawn: Readonly<Record<string, number>>;
  readonly shortfalls: ReadonlyArray<Shortfall>;
}

/**
 * Callers MUST pass `rows` in a stable, reproducible order. The shuffle is
 * seeded, but it shuffles the pool as built from `rows`, so an upstream that
 * enumerates pairs out of a Set or Map without sorting first yields a different
 * sample on a re-run even with the same seed.
 */
export function allocatedSample<T>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
  quotas: Readonly<Record<string, number>>,
  seed: number,
): AllocatedSampleResult<T> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    if (!(k in quotas)) continue;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }

  const selected: T[] = [];
  const drawn: Record<string, number> = {};
  const shortfalls: Shortfall[] = [];

  for (const k of Object.keys(quotas).sort()) {
    const pool = groups.get(k) ?? [];
    const want = quotas[k]!;
    const take = Math.min(want, pool.length);
    if (want > pool.length) {
      shortfalls.push({ stratum: k, wanted: want, available: pool.length });
    }
    const shuffled = seededShuffle(pool, makeRng(deriveSeed(seed, k)));
    selected.push(...shuffled.slice(0, take));
    drawn[k] = take;
  }

  return { selected, drawn, shortfalls };
}

/**
 * Splits `n` as evenly as possible across the distinct values of `subKeyOf`,
 * capping each at what is actually available and redistributing the remainder
 * to the sub-keys that still have room. This is what keeps the high-J' strata
 * from resolving to pure short-subagent boilerplate: without it, the sample
 * reproduces the size confound instead of measuring it.
 *
 * Allocation is round-robin over sorted sub-keys, so a remainder of 1 or 2 lands
 * on the alphabetically-first keys. At the quotas Stage A uses (30 to 53 across
 * three terciles) that bias is at most one pair and is not worth a seed to
 * randomize away.
 */
export function balancedQuota<T>(
  rows: ReadonlyArray<T>,
  subKeyOf: (row: T) => string,
  n: number,
): Record<string, number> {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const k = subKeyOf(row);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const keys = [...sizes.keys()].sort();
  const quota: Record<string, number> = {};
  for (const k of keys) quota[k] = 0;

  let remaining = Math.min(n, rows.length);
  while (remaining > 0) {
    const open = keys.filter((k) => quota[k]! < sizes.get(k)!);
    if (open.length === 0) break;
    const before = remaining;
    for (const k of open) {
      if (remaining === 0) break;
      quota[k]! += 1;
      remaining -= 1;
    }
    if (remaining === before) break;
  }
  return quota;
}
