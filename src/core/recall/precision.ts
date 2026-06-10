/**
 * Precision@K calculator: join query_log + citation_log by conversationId
 * to compute the fraction of surfaced sessions that were cited in the same
 * conversation. Metric for recall quality — high precision = returned results
 * are actually used.
 *
 * Inputs:
 * - queries: all recall queries logged, grouped by conversationId
 * - citations: all cited session IDs, grouped by conversationId
 *
 * Output:
 * - precisionAtK: average precision across conversations (null if no scoreable convs)
 * - conversationCount: number of conversations evaluated
 * - perConversation: breakdown by conversation, sorted by precision ascending
 */

import type { LogEntry } from "./query-log.js";
import type { CitationEntry } from "./citation-log.js";

export interface PrecisionResult {
  readonly precisionAtK: number | null;
  readonly conversationCount: number;
  readonly perConversation: ReadonlyArray<{
    readonly conversationId: string;
    readonly surfaced: number;
    readonly cited: number;
    readonly precision: number;
  }>;
}

export function computePrecision(
  queries: ReadonlyArray<{ conversationId: string; entry: LogEntry }>,
  citations: ReadonlyArray<CitationEntry>,
): PrecisionResult {
  // Build map: conversationId → set of cited session IDs
  const citedByConv = new Map<string, Set<string>>();
  for (const c of citations) {
    let s = citedByConv.get(c.conversationId);
    if (!s) {
      s = new Set();
      citedByConv.set(c.conversationId, s);
    }
    s.add(c.citedId);
  }

  // Build map: conversationId → set of surfaced session IDs
  const surfacedByConv = new Map<string, Set<string>>();
  for (const { conversationId, entry } of queries) {
    let s = surfacedByConv.get(conversationId);
    if (!s) {
      s = new Set();
      surfacedByConv.set(conversationId, s);
    }
    for (const id of entry.returnedIds) s.add(id);
  }

  // For each conversation, compute precision = (cited ∩ surfaced) / surfaced
  const perConversation: Array<{
    conversationId: string;
    surfaced: number;
    cited: number;
    precision: number;
  }> = [];

  for (const [convId, surfaced] of surfacedByConv) {
    // Skip conversations with no surfaced sessions
    if (surfaced.size === 0) continue;

    const cited = citedByConv.get(convId) ?? new Set<string>();
    const hits = [...surfaced].filter((id) => cited.has(id)).length;

    perConversation.push({
      conversationId: convId,
      surfaced: surfaced.size,
      cited: hits,
      precision: hits / surfaced.size,
    });
  }

  // If no scoreable conversations, return null
  if (perConversation.length === 0) {
    return { precisionAtK: null, conversationCount: 0, perConversation: [] };
  }

  // Compute average precision
  const avg =
    perConversation.reduce((sum, r) => sum + r.precision, 0) /
    perConversation.length;

  // Sort by precision ascending for reporting
  perConversation.sort((a, b) => a.precision - b.precision);

  return {
    precisionAtK: avg,
    conversationCount: perConversation.length,
    perConversation,
  };
}
