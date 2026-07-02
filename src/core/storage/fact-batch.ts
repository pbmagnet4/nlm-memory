import type { Fact } from "@shared/types.js";

/**
 * Returns the per-(subject, predicate) batch winners in insertion order.
 * Last occurrence in `facts` wins for each unique (subject, predicate) pair,
 * matching the collapse semantics of ingestSessionFactsInTxn (SQLite) and
 * ingestSessionFactsOnClient (PG). The returned array contains one entry per
 * unique key, ordered by the key's first appearance in the input.
 */
export function batchWinners(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const seen = new Map<string, Fact>();
  for (const f of facts) seen.set(`${f.subject}\u0000${f.predicate}`, f);
  return Array.from(seen.values());
}
