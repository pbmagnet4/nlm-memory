/**
 * warm-on-start for the code embedder.
 *
 * recall_code is vector-only and the capture path embeds fire-and-forget, so
 * the very first real capture against a cold CodeRankEmbed model can time out
 * and silently drop the vector. Warming the model once at daemon boot pays
 * that load cost up front, off the request path.
 *
 * Gated on NLM_CODE_EXEMPLARS_ENABLED=1 (the same flag that gates capture).
 * Best-effort and non-blocking: the embed is a throwaway, and any failure is
 * swallowed — a cold embedder must never block or crash daemon startup.
 */

import type { CodeEmbedder } from "@ports/code-embedder.js";

export function warmCodeEmbedder(embedder: CodeEmbedder): void {
  if (process.env["NLM_CODE_EXEMPLARS_ENABLED"] !== "1") return;
  void embedder.embed("warm", "query").catch(() => { /* best-effort; never block startup */ });
}
