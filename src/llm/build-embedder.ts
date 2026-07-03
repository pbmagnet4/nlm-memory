/**
 * Shared embedder factory used by the CLI daemon, the eval scripts, and the
 * backfill scripts. Reads NLM_EMBED_PROVIDER / NLM_EMBED_BASE_URL /
 * NLM_EMBED_MODEL / NLM_EMBED_API_KEY from the environment.
 *
 * autoloadEnv() is called FIRST so standalone scripts (eval, backfill) that
 * never load ~/.nlm/.env themselves still see the configured provider before
 * the branch decision is made.
 */

import type { LLMClient } from "../ports/llm-client.js";
import { OllamaClient } from "./ollama-client.js";
import { OpenAIEmbedderClient } from "./openai-embedder-client.js";
import { BundledEmbedderClient } from "./bundled-embedder-client.js";
import { autoloadEnv } from "./env-autoload.js";

export function buildEmbedder(): LLMClient {
  autoloadEnv();
  const provider = (process.env["NLM_EMBED_PROVIDER"] ?? "ollama").toLowerCase();
  if (provider === "openai") {
    const baseUrl = process.env["NLM_EMBED_BASE_URL"];
    if (!baseUrl) {
      throw new Error(
        "NLM_EMBED_PROVIDER=openai requires NLM_EMBED_BASE_URL (an OpenAI-compatible " +
          "/v1 endpoint), e.g. http://localhost:1234/v1 for LM Studio.",
      );
    }
    return new OpenAIEmbedderClient({
      baseUrl,
      ...(process.env["NLM_EMBED_MODEL"] ? { model: process.env["NLM_EMBED_MODEL"] } : {}),
      ...(process.env["NLM_EMBED_API_KEY"] ? { apiKey: process.env["NLM_EMBED_API_KEY"] } : {}),
    });
  }
  if (provider === "bundled") {
    const model = process.env["NLM_EMBED_MODEL"];
    const modelDir = process.env["NLM_BUNDLED_MODEL_DIR"];
    return new BundledEmbedderClient({
      ...(model ? { model } : {}),
      ...(modelDir ? { modelDir } : {}),
    });
  }
  return new OllamaClient({
    baseUrl: process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434",
    ...(process.env["NLM_EMBED_MODEL"] ? { embedModel: process.env["NLM_EMBED_MODEL"] } : {}),
  });
}
