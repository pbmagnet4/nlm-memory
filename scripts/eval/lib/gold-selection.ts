/**
 * Pure selection logic for the classifier eval's gold set (#403). Chooses
 * ~N sessions weighted toward ids seen in the citation log, with the
 * remainder filled by a seeded stratified sample over runtime x body-length
 * bucket. No I/O - the mulberry32 PRNG, seed derivation, and stratified
 * sampler are reused from recall-impact-replay-lib.ts rather than
 * reimplemented, so every eval's selection path shares one audited PRNG.
 *
 * See build-classifier-gold.ts for the I/O wrapper (DB read, file writes).
 */
import { deriveSeed, makeRng, seededShuffle, stratifiedSample } from "./recall-impact-replay-lib.js";

export interface GoldCandidate {
  readonly id: string;
  readonly runtime: string;
  readonly bodyLength: number;
}

export type LengthBucket = "short" | "medium" | "long";

/** Body-length bucket cut points, in characters. */
export const LENGTH_BUCKET_CUTS = { short: 3_000, medium: 10_000 } as const;

export function lengthBucket(len: number): LengthBucket {
  if (len < LENGTH_BUCKET_CUTS.short) return "short";
  if (len < LENGTH_BUCKET_CUTS.medium) return "medium";
  return "long";
}

/**
 * Max share of the gold set that citation-weighted selection can claim.
 * Leaves room for the stratified fill to still contribute runtime/length
 * diversity even when the citation pool alone is >= the full target size.
 */
export const CITATION_MAX_SHARE = 0.6;

export interface GoldSelectionResult {
  readonly selectedIds: ReadonlyArray<string>;
  readonly citationSelectedIds: ReadonlyArray<string>;
  readonly fillSelectedIds: ReadonlyArray<string>;
  readonly fillStrataCounts: Readonly<Record<string, number>>;
}

/**
 * Selects `n` ids from `pool`: first up to `floor(n * CITATION_MAX_SHARE)`
 * ids whose id is in `citedIds` (seeded shuffle, so ties don't always favor
 * insertion order), then fills the remainder with a stratified sample
 * (keyed on `runtime:lengthBucket`) over the rest of the pool. Deterministic
 * given the same `pool` order + `seed` - callers must pass `pool` in a
 * stable order (e.g. sorted by id).
 */
export function selectGoldSample(
  pool: ReadonlyArray<GoldCandidate>,
  citedIds: ReadonlySet<string>,
  n: number,
  seed: number,
): GoldSelectionResult {
  const target = Math.max(0, Math.min(n, pool.length));
  if (target === 0) {
    return { selectedIds: [], citationSelectedIds: [], fillSelectedIds: [], fillStrataCounts: {} };
  }

  const citedPool = pool.filter((p) => citedIds.has(p.id));
  const citationTake = Math.min(citedPool.length, Math.floor(target * CITATION_MAX_SHARE));
  const citationShuffled = seededShuffle(citedPool, makeRng(deriveSeed(seed, "citation")));
  const citationSelected = citationShuffled.slice(0, citationTake);
  const citationSelectedIds = citationSelected.map((c) => c.id);
  const citationSet = new Set(citationSelectedIds);

  const remainingPool = pool.filter((p) => !citationSet.has(p.id));
  const fillN = target - citationTake;
  const { selected: fillSelected, strataCounts: fillStrataCounts } = stratifiedSample(
    remainingPool,
    (p) => `${p.runtime}:${lengthBucket(p.bodyLength)}`,
    fillN,
    deriveSeed(seed, "fill"),
  );
  const fillSelectedIds = fillSelected.map((f) => f.id);

  return {
    selectedIds: [...citationSelectedIds, ...fillSelectedIds],
    citationSelectedIds,
    fillSelectedIds,
    fillStrataCounts,
  };
}

/**
 * Extracts distinct `cited_id` values from citation-log.jsonl content.
 * Malformed lines are skipped - the citation log is a best-effort weighting
 * signal, not a correctness boundary, so one bad row must not abort the
 * build.
 */
export function parseCitationLog(content: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const citedId = row["cited_id"];
      if (typeof citedId === "string" && citedId) ids.add(citedId);
    } catch {
      /* skip malformed line */
    }
  }
  return ids;
}
