/**
 * Shared classifier factory used by the CLI daemon and backfill scripts.
 * Reads NLM_CLASSIFIER / NLM_CLASSIFIER_MODEL / NLM_CLASSIFIER_BASE_URL /
 * NLM_CLASSIFIER_API_KEY / NLM_CLASSIFIER_MAX_TOKENS / NLM_OLLAMA_URL.
 *
 * autoloadEnv() runs FIRST (unconditionally) so standalone scripts (backfill)
 * read the configured provider from ~/.nlm/.env before the branch decision.
 * Reading NLM_CLASSIFIER before autoload would default to ollama and silently
 * bind nothing when the real provider lives in .env (matches buildEmbedder).
 */

import { autoloadEnv } from "./env-autoload.js";
import { ClassifierBox, type ClassifierProvider } from "./classifier-box.js";

export function buildClassifier(): ClassifierBox {
  autoloadEnv();
  const provider = ((process.env["NLM_CLASSIFIER"] ?? "ollama").toLowerCase() as ClassifierProvider);
  const modelDefault =
    provider === "ollama" ? "qwen3.5:4b" : provider === "deepseek" ? "deepseek-v4-flash" : undefined;
  const model = process.env["NLM_CLASSIFIER_MODEL"] ?? modelDefault;
  if (!model) {
    throw new Error(
      "NLM_CLASSIFIER=openai requires NLM_CLASSIFIER_MODEL (the model id served by your endpoint), " +
        "e.g. qwen3.5-4b-mlx.",
    );
  }
  const maxTokensRaw = Number.parseInt(process.env["NLM_CLASSIFIER_MAX_TOKENS"] ?? "", 10);
  return new ClassifierBox({
    provider,
    model,
    ollamaUrl: process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434",
    ...(process.env["NLM_CLASSIFIER_BASE_URL"] ? { baseUrl: process.env["NLM_CLASSIFIER_BASE_URL"] } : {}),
    ...(process.env["NLM_CLASSIFIER_API_KEY"] ? { apiKey: process.env["NLM_CLASSIFIER_API_KEY"] } : {}),
    ...(Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? { maxTokens: maxTokensRaw } : {}),
  });
}
