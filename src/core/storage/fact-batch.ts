import { propertyAssociationsEnabled } from "@core/properties/model.js";
import { factClassOf, factClassesEnabled } from "@core/facts/fact-classes.js";
import type { Fact } from "@shared/types.js";

/**
 * Returns the per-(property, subject, predicate) batch winners in insertion order.
 * Last occurrence in `facts` wins for each unique (subject, predicate) pair,
 * matching the collapse semantics of ingestSessionFactsInTxn (SQLite) and
 * ingestSessionFactsOnClient (PG). The returned array contains one entry per
 * unique key, ordered by the key's first appearance in the input. With
 * NLM_FACT_CLASSES=on every event-class fact is its own entry (all are kept).
 */
export function batchWinners(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const classes = factClassesEnabled();
  const preserveUnresolved = propertyAssociationsEnabled();
  const seen = new Map<string, Fact>();
  for (const f of facts) {
    const independent = (classes && factClassOf(f.predicate) === "event") || (f.property?.slug == null && (preserveUnresolved || f.property?.source === "operator"));
    const key = independent ? f.id : `${f.property?.slug ?? ""}\u0000${f.subject}\u0000${f.predicate}`;
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
  return batchWinners(facts).filter((f) => !(f.property?.slug == null && (propertyAssociationsEnabled() || f.property?.source === "operator"))).filter((f) => !(classes && factClassOf(f.predicate) === "event"));
}

export async function storedBatchWinners(
  store: Pick<import("@ports/fact-store.js").FactStore, "getByIds">, tenantId: string, facts: readonly Fact[],
): Promise<readonly Fact[]> {
  const stored = new Map((await store.getByIds(tenantId, facts.map((f) => f.id))).map((f) => [f.id, f]));
  const attributed = facts.flatMap((f) => stored.has(f.id) ? [stored.get(f.id)!] : []);
  return batchWinners(attributed).filter((f) => f.supersededBy === null && f.retiredAt == null);
}
