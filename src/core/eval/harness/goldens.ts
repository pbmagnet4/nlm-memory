/**
 * Golden-set derivation for the eval harness. Pure functions over log text so
 * the CI test can drive them with an invented corpus.
 *
 * Session labels come from usage: a session is relevant to a query when a LATER
 * citation in the same conversation cites an id that the query had returned.
 * Limits (also stated in docs/eval-harness.md): only queries that carry a
 * conversation id can be joined; relevance is restricted to ids the query
 * returned, so the set measures how well the ranker orders what retrieval
 * already found, not what it never surfaced; a citation shows the agent used a
 * session, not that it was the best one.
 */

import { createHash } from "node:crypto";

export type Split = "dev" | "heldout";

export interface Golden {
  readonly query: string;
  readonly relevantIds: ReadonlyArray<string>;
  readonly split: Split;
  /** Where the label came from; "synthetic-topic" labels are not usage-derived. */
  readonly labelSource: "citation" | "synthetic-topic";
  readonly sources: ReadonlyArray<string>;
}

export interface Citation {
  readonly ts: string;
  readonly conversationId: string;
  readonly citedId: string;
}

/** Stable 70/30 split on the query text, independent of log order. */
export function splitOf(query: string, devShare = 0.7): Split {
  const h = createHash("sha256").update(query).digest().readUInt32BE(0);
  return h / 0x1_0000_0000 < devShare ? "dev" : "heldout";
}

function parseLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj !== null && typeof obj === "object") out.push(obj as Record<string, unknown>);
    } catch {
      // A torn final line from copying a live log is expected; skip it.
    }
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Citations from citation-log.jsonl plus the cited ids on hook `stop` records, deduplicated. */
export function readCitations(citationLogText: string, hookLogText: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  const add = (ts: string | null, conversationId: string | null, citedId: string | null): void => {
    if (!ts || !conversationId || !citedId) return;
    const key = `${conversationId}|${citedId}|${ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ts, conversationId, citedId });
  };
  for (const r of parseLines(citationLogText)) add(str(r["ts"]), str(r["conversation_id"]), str(r["cited_id"]));
  for (const r of parseLines(hookLogText)) {
    if (r["kind"] !== "stop") continue;
    for (const id of strs(r["citedIds"])) add(str(r["ts"]), str(r["conversationId"]), id);
  }
  return out;
}

/** (query -> relevant ids) from a query log (query_log.jsonl or fact_query_log.jsonl). */
export function deriveCitationGoldens(
  queryLogText: string,
  citations: ReadonlyArray<Citation>,
  idPrefix: string,
): Golden[] {
  const byConv = new Map<string, Citation[]>();
  for (const c of citations) {
    if (!c.citedId.startsWith(idPrefix)) continue;
    const list = byConv.get(c.conversationId) ?? [];
    list.push(c);
    byConv.set(c.conversationId, list);
  }
  const byQuery = new Map<string, { ids: Set<string>; sources: Set<string> }>();
  for (const r of parseLines(queryLogText)) {
    const query = str(r["query"]);
    const conv = str(r["conversation_id"]);
    const ts = str(r["ts"]);
    if (!query || !conv || !ts) continue;
    const later = byConv.get(conv);
    if (!later) continue;
    const returned = new Set(strs(r["returned_ids"]));
    const hits = later.filter((c) => c.ts > ts && returned.has(c.citedId)).map((c) => c.citedId);
    if (hits.length === 0) continue;
    const slot = byQuery.get(query) ?? { ids: new Set<string>(), sources: new Set<string>() };
    for (const h of hits) slot.ids.add(h);
    slot.sources.add(str(r["source"]) ?? "unknown");
    byQuery.set(query, slot);
  }
  return [...byQuery].map(([query, v]) => ({
    query,
    relevantIds: [...v.ids].sort(),
    split: splitOf(query),
    labelSource: "citation" as const,
    sources: [...v.sources].sort(),
  }));
}

export interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
}

/**
 * Synthetic topic goldens for facts: the query frames a fact's subject and
 * predicate with the value held out. Only (subject, predicate) pairs that are
 * unique among active facts qualify, so each query has exactly one right answer.
 * Fact citations are too rare to derive labels from usage (see the doc), so
 * this is the fact lane's label source. Sampling is by id hash, so it is stable.
 */
export function deriveFactTopicGoldens(activeFacts: ReadonlyArray<FactRow>, limit: number): Golden[] {
  const counts = new Map<string, number>();
  for (const f of activeFacts) {
    const k = `${f.subject}\u0000${f.predicate}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const unique = activeFacts.filter((f) => counts.get(`${f.subject}\u0000${f.predicate}`) === 1);
  const ranked = unique
    .map((f) => ({ f, h: createHash("sha256").update(f.id).digest("hex") }))
    .sort((a, b) => (a.h < b.h ? -1 : 1))
    .slice(0, limit);
  const seen = new Set<string>();
  const out: Golden[] = [];
  for (const { f } of ranked) {
    const query = `${f.subject} ${f.predicate}`;
    if (seen.has(query)) continue;
    seen.add(query);
    out.push({ query, relevantIds: [f.id], split: splitOf(query), labelSource: "synthetic-topic", sources: ["topic"] });
  }
  return out;
}

export interface GoldenSets {
  readonly session: ReadonlyArray<Golden>;
  readonly fact: ReadonlyArray<Golden>;
  readonly factCitation: ReadonlyArray<Golden>;
}

export function summarizeGoldens(g: ReadonlyArray<Golden>): { dev: number; heldout: number; total: number } {
  const dev = g.filter((x) => x.split === "dev").length;
  return { dev, heldout: g.length - dev, total: g.length };
}
