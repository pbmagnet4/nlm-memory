/**
 * resolveEmbedderInfo — the descriptor `/api/classifier/info` reports for the
 * active embedder. It mirrors `buildEmbedder`'s provider/model selection from
 * the same env, so the UI shows the embedder that's actually running rather
 * than a hardcoded default.
 *
 * dims is always 768: NLM's vec schema is fixed at 768, so any valid embedder
 * (nomic / CodeRank) must produce 768-d vectors.
 */

import { DEFAULT_OPENAI_EMBED_MODEL } from "./openai-embedder-client.js";

const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";

export interface EmbedderDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
}

export function resolveEmbedderInfo(
  env: Record<string, string | undefined> = process.env,
): EmbedderDescriptor {
  const provider = (env["NLM_EMBED_PROVIDER"] ?? "ollama").toLowerCase();
  const model =
    provider === "openai"
      ? (env["NLM_EMBED_MODEL"] ?? DEFAULT_OPENAI_EMBED_MODEL)
      : DEFAULT_OLLAMA_EMBED_MODEL;
  return { provider, model, dims: 768 };
}
