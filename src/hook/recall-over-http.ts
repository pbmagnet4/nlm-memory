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

export const RECALL_LIMIT = 5;
export const RECALL_TIMEOUT_MS = 2000;

export interface RecallOverHttpResult {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly facts: ReadonlyArray<PointerFact>;
  readonly exemplars: ReadonlyArray<PointerExemplar>;
}

export async function recallOverHttp(
  prompt: string,
  runtime?: string,
  conversationId?: string,
): Promise<RecallOverHttpResult> {
  const query = extractRecallQuery(prompt);
  if (query === null) return { hits: [], facts: [], exemplars: [] };
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url =
    `http://localhost:${portValue}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=keyword&limit=${RECALL_LIMIT}&withFacts=true&withExemplars=true` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const extra: Record<string, string> = { "x-recall-source": "hook" };
    if (runtime) extra["x-recall-runtime"] = runtime;
    const res = await fetch(url, {
      headers: hookAuthHeaders(extra),
      signal: controller.signal,
    });
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
  } finally {
    clearTimeout(timer);
  }
}
