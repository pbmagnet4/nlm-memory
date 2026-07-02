import type { ClassifyResult } from "@ports/llm-client.js";
import { ClassifierSchemaError, LLMUnreachableError } from "@ports/llm-client.js";
import {
  coerceClassifyResult,
  stripJsonFences,
  validateClassifierJson,
} from "@core/classifier/prompt.js";

export async function classifyWithRetry(
  attempts: number,
  once: () => Promise<ClassifyResult>,
): Promise<ClassifyResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await once();
    } catch (e) {
      if (!(e instanceof ClassifierSchemaError || e instanceof LLMUnreachableError)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export function parseClassifierContent(rawContent: string, providerLabel: string): ClassifyResult {
  const content = stripJsonFences(rawContent.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ClassifierSchemaError(`${providerLabel} returned non-JSON content`);
  }
  if (!validateClassifierJson(parsed)) {
    throw new ClassifierSchemaError(`${providerLabel} response missing required keys`);
  }
  return coerceClassifyResult(parsed);
}

const DEFAULT_REWRITE_TIMEOUT_MS = 5_000;
export function rewriteTimeoutMs(): number {
  const raw = process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  if (!raw) return DEFAULT_REWRITE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REWRITE_TIMEOUT_MS;
}
