import { factClassOf, factClassesEnabled } from "@core/facts/fact-classes.js";
import type { Fact } from "@shared/types.js";

/**
 * Returns the per-(subject, predicate) batch winners in insertion order.
 * Last occurrence in `facts` wins for each unique (subject, predicate) pair,
 * matching the collapse semantics of ingestSessionFactsInTxn (SQLite) and
 * ingestSessionFactsOnClient (PG). The returned array contains one entry per
 * unique key, ordered by the key's first appearance in the input. With
 * NLM_FACT_CLASSES=on every event-class fact is its own entry (all are kept).
 */
export function batchWinners(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const classes = factClassesEnabled();
  const seen = new Map<string, Fact>();
  for (const f of facts) {
    const key = classes && factClassOf(f.predicate) === "event" ? f.id : `${f.subject}\u0000${f.predicate}`;
    seen.set(key, f);
  }
  return Array.from(seen.values());
}

/**
 * The winners that supersede earlier facts on write. With NLM_FACT_CLASSES=on,
 * event-class facts (all kept, see fact-classes.ts) supersede nothing.
 */
export function collapseWinners(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const classes = factClassesEnabled();
  return batchWinners(facts).filter((f) => !(classes && factClassOf(f.predicate) === "event"));
}
