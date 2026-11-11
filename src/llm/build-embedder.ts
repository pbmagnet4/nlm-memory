/**
 * Shared embedder factory used by the CLI daemon, the eval scripts, and the
 * backfill scripts. `buildEmbedder()` reads NLM_EMBED_PROVIDER /
 * NLM_EMBED_BASE_URL / NLM_EMBED_MODEL / NLM_EMBED_API_KEY from the
 * environment; the daemon instead resolves persisted settings over env and
 * calls `buildEmbedderFrom` / `buildCodeEmbedderFrom` with the result.
 *
 * autoloadEnv() is called FIRST in buildEmbedder() so standalone scripts
 * (eval, backfill) that never load ~/.nlm/.env themselves still see the
 * configured provider before the branch decision is made.
 */

import type { LLMClient } from "../ports/llm-client.js";
import type { CodeEmbedder } from "../ports/code-embedder.js";
import { OllamaClient } from "./ollama-client.js";
import { OpenAIEmbedderClient, type FetchImpl } from "./openai-embedder-client.js";
import { OpenAICodeEmbedderClient } from "./openai-code-embedder-client.js";
import { OllamaCodeEmbedder } from "./ollama-code-embedder.js";
import { BundledEmbedderClient } from "./bundled-embedder-client.js";
import { autoloadEnv } from "./env-autoload.js";
import { laneValues, resolveEmbedderLane, type EmbedderLaneValues } from "../core/embedding/embedder-config.js";
import { NO_STORED_EMBEDDER } from "../ports/embedder-settings-store.js";

export function buildEmbedderFrom(cfg: EmbedderLaneValues, fetchImpl?: FetchImpl): LLMClient {
  if (cfg.provider === "openai") {
    if (!cfg.baseUrl) {
      throw new Error(
        "NLM_EMBED_PROVIDER=openai requires NLM_EMBED_BASE_URL (an OpenAI-compatible " +
          "/v1 endpoint), e.g. http://localhost:1234/v1 for LM Studio.",
      );
    }
    return new OpenAIEmbedderClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  if (cfg.provider === "bundled") {
    const modelDir = process.env["NLM_BUNDLED_MODEL_DIR"];
    return new BundledEmbedderClient({ model: cfg.model, ...(modelDir ? { modelDir } : {}) });
  }
  return new OllamaClient({ baseUrl: cfg.baseUrl ?? "http://localhost:11434", embedModel: cfg.model });
}

/** The bundled provider has no code-embedding engine (CodeRankEmbed has no ONNX
 *  equivalent), so it falls through to Ollama: the startup probe fails soft and
 *  the code-exemplar lane stays unknown, which is the intended degradation. */
export function buildCodeEmbedderFrom(cfg: EmbedderLaneValues, fetchImpl?: FetchImpl): CodeEmbedder {
  if (cfg.provider === "openai") {
    if (!cfg.baseUrl) {
      throw new Error(
        "NLM_EMBED_PROVIDER=openai requires NLM_EMBED_BASE_URL for the code embedder too, " +
          "e.g. http://localhost:1234/v1 for LM Studio.",
      );
    }
    return new OpenAICodeEmbedderClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  return new OllamaCodeEmbedder({ baseUrl: cfg.baseUrl ?? "http://localhost:11434", model: cfg.model });
}

export function buildEmbedder(): LLMClient {
  autoloadEnv();
  return buildEmbedderFrom(laneValues(resolveEmbedderLane("prose", NO_STORED_EMBEDDER, process.env)));
}
