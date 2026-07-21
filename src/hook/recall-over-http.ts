/**
 * Shared HTTP recall client for hook entrypoints (Claude Code script, pi extension).
 *
 * Keyword (FTS5) only — hybrid would round-trip through Ollama embedding
 * (~5s warm), too slow to block a user prompt.
 *
 * Spec G.2: also extracts the optional `relatedFacts` array (current
 * high-confidence facts about the entities in the top hits). The HTTP
 * handler returns this whenever a hook source asks for it; callers that
 * don't want facts simply ignore the second return value.
 *
 * Spec §E: also extracts the optional `relatedExemplars` array (passive
 * code exemplar recall). The HTTP handler returns this when &withExemplars=true.
 */

import type { RecallHitInput } from "@core/hook/select.js";
import type { PointerExemplar, PointerFact } from "@core/hook/pointer-block.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { extractRecallQuery } from "@core/hook/query-extract.js";
import { fetchWithTimeout } from "./hook-helpers.js";
import { DEFAULT_NLM_PORT } from "../shared/net.js";

export const RECALL_LIMIT = 5;

// #396: the budget must exceed the daemon's worst-case sequential hybrid path
// (keyword ~839ms + embed capped at NLM_RECALL_EMBED_DEADLINE_MS default 2000ms
// + semantic ~50ms + response overhead ~100ms = ~2990ms floor). A budget at or
// below the daemon's embed cap re-creates the dead passive layer even after the
// daemon-side embed fix in 73406260: the hook gives up before the embed deadline
// fires and the daemon finishes building the response.
export function parseRecallTimeout(raw: string | undefined): number {
  if (raw === undefined) return 4000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

export const RECALL_TIMEOUT_MS = parseRecallTimeout(process.env["NLM_HOOK_RECALL_TIMEOUT_MS"]);

export interface RecallOverHttpResult {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly facts: ReadonlyArray<PointerFact>;
  readonly exemplars: ReadonlyArray<PointerExemplar>;
}

export async function recallOverHttp(
  prompt: string,
  runtime?: string,
  conversationId?: string,
  mode: "keyword" | "hybrid" = "keyword",
): Promise<RecallOverHttpResult> {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [], exemplars: [] };
  const portValue = process.env["NLM_PORT"] ?? DEFAULT_NLM_PORT;
  const url =
    // 127.0.0.1, not localhost: each hook is a fresh process with no connection
    // reuse, and Node resolves localhost to IPv6 ::1 first — a measured ~50-300ms
    // per-fire connect penalty vs ~3ms on the explicit IPv4 loopback.
    `http://127.0.0.1:${portValue}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=${mode}&limit=${RECALL_LIMIT}&withFacts=true&withExemplars=true` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "");
  try {
    const extra: Record<string, string> = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetchWithTimeout(url, { headers: hookAuthHeaders(extra) }, RECALL_TIMEOUT_MS);
    if (!res.ok) return { hits: [], facts: [], exemplars: [] };
    type RecallBody = {
      results?: ReadonlyArray<{
        id: string;
        label: string;
        startedAt: string;
        matchScore: number;
        summary?: string;
      }>;
      relatedFacts?: ReadonlyArray<{
        subject: string;
        predicate: string;
        value: string;
        corroborationCount: number;
      }>;
      relatedExemplars?: ReadonlyArray<{
        outcome: string;
        lang: string | null;
        repo: string;
        taskContext: string;
      }>;
    };
    let body: RecallBody;
    try {
      body = (await res.json()) as RecallBody;
    } catch {
      return { hits: [], facts: [], exemplars: [] };
    }
    const hits = (body.results ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      startedAt: r.startedAt,
      matchScore: r.matchScore,
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
    }));
    const facts = (body.relatedFacts ?? []).map((f) => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      corroborationCount: f.corroborationCount,
    }));
    const exemplars = (body.relatedExemplars ?? []).map((e) => ({
      outcome: e.outcome,
      lang: e.lang,
      repo: e.repo,
      taskContext: e.taskContext,
    }));
    return { hits, facts, exemplars };
  } catch {
    return { hits: [], facts: [], exemplars: [] };
  }
}
