import type { FactHit, RecallHit, Session } from "@shared/types.js";
import { matchedPassages, relevantStrings } from "./session-evidence.js";

export function buildContextBundle(
  query: string, facts: readonly FactHit[], hits: readonly RecallHit[],
  sources: readonly Session[], maxChars: number,
) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const factRecords = facts.flatMap((f) => {
    const key = JSON.stringify([f.subject, f.predicate, f.value]);
    if (seen.has(key)) return [];
    seen.add(key);
    const source = byId.get(f.sourceSessionId);
    return [{ id: f.id, kind: f.kind, subject: f.subject, predicate: f.predicate,
      value: f.value, createdAt: f.createdAt, confidence: f.confidence,
      multipleValues: new Set(facts.filter((other) => other.subject === f.subject && other.predicate === f.predicate)
        .map((other) => other.value)).size > 1,
      sourceSessionIds: [...new Set(facts.filter((other) => other.subject === f.subject && other.predicate === f.predicate && other.value === f.value)
        .map((other) => other.sourceSessionId))],
      source: { id: f.sourceSessionId, status: source?.status ?? "unavailable",
        supersededBy: source?.supersededBy ?? null },
      sourceQuote: f.sourceQuote,
      quoteVerified: f.sourceQuote && source?.body ? source.body.includes(f.sourceQuote) : null,
      expand: { id: f.sourceSessionId },
    }];
  });
  const sessionRecords = hits.flatMap((h) => {
    const session = byId.get(h.id);
    if (!session) return [];
    return [{ id: h.id, label: h.label, startedAt: h.startedAt, status: h.status,
      supersededBy: h.supersededBy, summary: h.summary,
      decisions: relevantStrings(h.decisions, query, 2), open: relevantStrings(h.open, query, 2),
      passages: matchedPassages(session, query, h.chunkIndex, Math.min(800, Math.floor(maxChars / 8))),
      expand: { id: h.id },
    }];
  });
  const bundle = { query: query.slice(0, 200), queryShortened: query.length > 200, facts: [] as typeof factRecords, sessions: [] as typeof sessionRecords,
    omitted: { facts: factRecords.length, sessions: sessionRecords.length },
    budgetChars: maxChars,
    expand: [...hits.map((h) => ({ id: h.id })),
      ...facts.slice(0, 2).map((f) => ({ id: f.sourceSessionId }))].slice(0, 3),
  };
  // Fit whole evidence records, including provenance, rather than chopping a
  // claim into a misleading fragment. Leave room for transport/degradation info.
  const factBudget = sessionRecords.length > 0 ? Math.floor(maxChars * 0.45) : maxChars - 500;
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
  return bundle;
}
