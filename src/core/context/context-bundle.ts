import type { FactHit, RecallHit, Session } from "@shared/types.js";
import { matchedPassages, relevantStrings } from "./session-evidence.js";

export interface ContextLookup {
  readonly subject: string;
  readonly predicate: string;
  readonly distinctValueCount: number | null;
  readonly sourceSessionCount: number | null;
  readonly complete: boolean;
}

export function buildContextBundle(
  query: string, facts: readonly FactHit[], hits: readonly RecallHit[],
  sources: readonly Session[], maxChars: number, workstream?: string, lookup?: ContextLookup,
) {
  const scopeArgs = workstream !== undefined ? { workstream } : {};
  const byId = new Map(sources.map((s) => [s.id, s]));
  const groups = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.subject, fact.predicate]);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(fact.value);
  }
  const seen = new Set<string>();
  const factRecords = facts.flatMap((f) => {
    const key = JSON.stringify([f.subject, f.predicate, f.value]);
    if (seen.has(key)) return [];
    seen.add(key);
    const source = byId.get(f.sourceSessionId);
    return [{ id: f.id, kind: f.kind, subject: f.subject, predicate: f.predicate,
      value: f.value, createdAt: f.createdAt, confidence: f.confidence,
      multipleValues: lookup?.complete && lookup.subject === f.subject && lookup.predicate === f.predicate
        ? lookup.distinctValueCount! > 1 : groups.get(JSON.stringify([f.subject, f.predicate]))!.size > 1,
      multipleValuesScope: lookup?.complete && lookup.subject === f.subject && lookup.predicate === f.predicate ? "corpus" : "candidates",
      sourceSessionIds: [...new Set(facts.filter((other) => other.subject === f.subject && other.predicate === f.predicate && other.value === f.value)
        .map((other) => other.sourceSessionId))],
      source: { id: f.sourceSessionId, status: source?.status ?? "unavailable",
        supersededBy: source?.supersededBy ?? null },
      sourceQuote: f.sourceQuote,
      quoteVerified: f.sourceQuote && source?.body ? source.body.includes(f.sourceQuote) : null,
      expand: { id: f.sourceSessionId, ...scopeArgs },
    }];
  });
  const sessionRecords = hits.flatMap((h) => {
    const session = byId.get(h.id);
    if (!session) return [];
    const passages = matchedPassages(session, query, h.chunkIndex, Math.min(800, Math.floor(maxChars / 8)));
    return [{ id: h.id, label: h.label, startedAt: h.startedAt, status: h.status,
      supersededBy: h.supersededBy, summary: h.summary,
      decisions: relevantStrings(h.decisions, query, 2), open: relevantStrings(h.open, query, 2),
      passages,
      expand: h.chunkIndex !== undefined && passages.length > 0
        ? { id: h.id, ...scopeArgs, view: "transcript", offset: passages[0]!.offset } : { id: h.id, ...scopeArgs },
    }];
  });
  const lookupRecord = lookup ? { distinctValueCount: lookup.distinctValueCount, complete: lookup.complete,
    sourceSessionCount: lookup.sourceSessionCount, omittedAlternatives: lookup.distinctValueCount,
    expand: { subject: lookup.subject, predicate: lookup.predicate, ...scopeArgs } } : undefined;
  const bundle = { ...(lookupRecord ? { lookup: lookupRecord } : {}), query: query.slice(0, 200), queryShortened: query.length > 200, facts: [] as typeof factRecords, sessions: [] as typeof sessionRecords,
    omitted: { facts: factRecords.length, sessions: sessionRecords.length },
    budgetChars: maxChars,
    expand: [...sessionRecords.map((s) => s.expand),
      ...facts.slice(0, 2).map((f) => ({ id: f.sourceSessionId, ...scopeArgs }))].slice(0, 3),
  };
  // Fit whole evidence records, including provenance, rather than chopping a
  // claim into a misleading fragment. Leave room for transport/degradation info.
  const reserve = sessionRecords.length > 0
    ? Math.min(maxChars - 1_000, JSON.stringify(sessionRecords[0]).length + 50) : 0;
  const factBudget = Math.min(sessionRecords.length ? Math.floor(maxChars * 0.45) : maxChars, maxChars - 500 - reserve);
  for (const fact of factRecords) {
    bundle.facts.push(fact);
    bundle.omitted.facts--;
    if (JSON.stringify(bundle).length > factBudget) {
      bundle.facts.pop();
      bundle.omitted.facts++;
    }
  }
  for (const session of sessionRecords) {
    bundle.sessions.push(session);
    bundle.omitted.sessions--;
    if (JSON.stringify(bundle).length > maxChars - 500) {
      bundle.sessions.pop();
      bundle.omitted.sessions++;
    }
  }
  if (bundle.lookup && lookup && lookup.distinctValueCount !== null) {
    const returnedValues = new Set(bundle.facts.filter((f) => f.subject === lookup.subject && f.predicate === lookup.predicate).map((f) => f.value));
    bundle.lookup.omittedAlternatives = Math.max(0, lookup.distinctValueCount - returnedValues.size);
  }
  return bundle;
}
