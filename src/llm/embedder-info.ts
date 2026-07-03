/**
 * resolveEmbedderInfo — the descriptor `/api/classifier/info` reports for the
 * active embedder. It mirrors `buildEmbedder`'s provider/model selection from
 * the same env, so the UI shows the embedder that's actually running rather
 * than a hardcoded default.
 *
 * Pass `dim` from the live embedder probe; without it, the descriptor
 * defaults to 768, which may not match the active embedder's dims.
 */

import { DEFAULT_OPENAI_EMBED_MODEL } from "./openai-embedder-client.js";
import { DEFAULT_MODEL_REPO } from "./bundled-embedder-client.js";

const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";

export interface EmbedderDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
}

export function resolveEmbedderInfo(
  env: Record<string, string | undefined> = process.env,
  dim?: number,
): EmbedderDescriptor {
  const provider = (env["NLM_EMBED_PROVIDER"] ?? "ollama").toLowerCase();
  let model: string;
  if (provider === "openai") {
    model = env["NLM_EMBED_MODEL"] ?? DEFAULT_OPENAI_EMBED_MODEL;
  } else if (provider === "bundled") {
    model = env["NLM_EMBED_MODEL"] ?? DEFAULT_MODEL_REPO;
  } else {
    model = env["NLM_EMBED_MODEL"] ?? DEFAULT_OLLAMA_EMBED_MODEL;
  }
  return { provider, model, dims: dim ?? 768 };
}
