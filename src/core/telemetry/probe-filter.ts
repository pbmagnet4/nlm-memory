/**
 * Probe and test traffic filter.
 *
 * Single source of truth for classifying recall queries as probe/test traffic.
 * Used by the digest composer (to strip probes from displayed counters) and by
 * the pull-usefulness eval script (to strip probes from the scored baseline).
 *
 * Two match strategies with different trade-offs:
 *
 * Substring match (PROBE_SUBSTRINGS / isProbe):
 *   Catches probe traffic regardless of surrounding words. Accepted trade-off:
 *   any query containing the word "probe" -- including "how did we probe the API"
 *   -- will be stripped. In practice, probe traffic is always labelled with the
 *   bare word; real agent queries rarely include "probe" as a term. The
 *   alternative (exact-match "probe") would miss operational variants like
 *   "system probe" and "probing X", so substring is the right default for the
 *   digest composer path.
 *
 * Exact match (PROBE_EXACT_QUERIES):
 *   Required for pull-usefulness.ts. That script was baseline-calibrated at
 *   72.4% genuine-pull using this exact set. Switching it to substring matching
 *   would silently change the denominator and invalidate historical comparisons.
 *   "x" and "" cannot be substring-matched -- a single character would strip
 *   virtually every query. They live here as exact entries only.
 */

/** Substrings that mark a recall query as probe/test traffic. */
export const PROBE_SUBSTRINGS: ReadonlyArray<string> = [
  // "concurrency probe" and "test probe" are redundant: "probe" covers both.
  "probe",
  "beacon",
  "smoke",
  "path test",
  "recall test",
  "cutover-test",
];

/**
 * Queries that are probe traffic only when the full query (trimmed, lowercased)
 * is an exact match. "x" and "" are single-character or empty -- substring
 * matching them would strip real queries.
 */
export const PROBE_EXACT_QUERIES: ReadonlySet<string> = new Set([
  "pgvector",
  "hono",
  "x",
  "",
]);

/** True when the query is recognisably probe/test traffic by either strategy. */
export function isProbe(query: string | null | undefined): boolean {
  if (query === null || query === undefined) return false;
  const q = query.trim().toLowerCase();
  if (PROBE_EXACT_QUERIES.has(q)) return true;
  return PROBE_SUBSTRINGS.some((p) => q.includes(p));
}
