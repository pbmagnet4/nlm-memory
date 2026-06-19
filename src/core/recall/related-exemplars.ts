/**
 * Passive code-exemplar recall: embed the user's task in CodeRankEmbed space
 * and return the nearest captured exemplars as lean pointers for the recall
 * block. Best-effort — any failure yields []. Precision-biased: only matches
 * within maxDistance are returned, capped at k, so the injected block stays
 * relevant and small (the full code is pulled on demand via recall_code).
 */
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { RelatedExemplar } from "@shared/types.js";

const DEFAULT_K = 2;
const DEFAULT_MAX_DISTANCE = Number(process.env["NLM_EXEMPLAR_RECALL_MAX_DISTANCE"] ?? "1.0");

export async function pickRelatedExemplars(
  query: string,
  store: CodeExemplarStore,
  codeEmbedder: CodeEmbedder,
  installScope: string,
  opts: { k?: number; maxDistance?: number } = {},
): Promise<RelatedExemplar[]> {
  const k = opts.k ?? DEFAULT_K;
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  try {
    const { vector } = await codeEmbedder.embed(query, "query");
    const hits = await store.searchByVector(vector, { installScope, k });
    return hits
      .filter((h) => h.distance <= maxDistance)
      .slice(0, k)
      .map((h) => ({
        id: h.id,
        outcome: h.outcome,
        lang: h.lang,
        repo: h.repo,
        taskContext: h.taskContext,
        distance: h.distance,
      }));
  } catch {
    return [];
  }
}
