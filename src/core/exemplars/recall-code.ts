/**
 * recall-code — semantic search over the code-exemplar lane.
 *
 * Embeds the query with the code embedder (or falls back to the prose embedder),
 * delegates to CodeExemplarStore.searchByVector, and formats results.
 * Negatives are returned clearly labeled — "code that failed the gate" is
 * as useful to the caller as the positive.
 */

import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { CodeExemplarSearchFilter, CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { CodeExemplarHit } from "@shared/types.js";
import { laneHealth } from "@core/health/embedding-lane-state.js";

export interface RecallCodeOptions extends CodeExemplarSearchFilter {
  /** Natural-language description of the task. Used to build the query vector. */
  readonly query: string;
}

export interface RecallCodeResult {
  readonly positives: ReadonlyArray<CodeExemplarHit>;
  readonly negatives: ReadonlyArray<CodeExemplarHit>;
}

/**
 * Recall code exemplars. Returns positives (pass/fix) and negatives (fail/exhausted)
 * as separate lists so the caller can surface them with distinct framing.
 */
export async function recallCode(
  tenantId: string,
  opts: RecallCodeOptions,
  store: CodeExemplarStore,
  codeEmbedder: CodeEmbedder | null,
  proseFallback: LLMClient | null,
): Promise<RecallCodeResult> {
  if (laneHealth("code") === "stale") {
    return { positives: [], negatives: [] };
  }

  let queryVector: Float32Array | null = null;

  if (codeEmbedder) {
    try {
      const result = await codeEmbedder.embed(opts.query, "query");
      queryVector = result.vector;
    } catch {
      // Degraded: fall through to prose fallback
    }
  }

  if (!queryVector && proseFallback) {
    try {
      const result = await proseFallback.embed(opts.query, "query");
      queryVector = result.vector;
    } catch {
      // No embedder available
    }
  }

  if (!queryVector) {
    return { positives: [], negatives: [] };
  }

  const filter: CodeExemplarSearchFilter = {
    installScope: opts.installScope,
    ...(opts.repo !== undefined && { repo: opts.repo }),
    ...(opts.lang !== undefined && { lang: opts.lang }),
    ...(opts.model !== undefined && { model: opts.model }),
    includeNegatives: opts.includeNegatives ?? true,
    k: opts.k ?? 5,
  };

  const hits = await store.searchByVector(tenantId, queryVector, filter);

  const positives = hits.filter((h) => h.outcome === "pass" || h.outcome === "fix");
  const negatives = hits.filter((h) => h.outcome === "fail" || h.outcome === "exhausted");

  return { positives, negatives };
}
