/**
 * OllamaClient — LLMClient backed by a local Ollama HTTP endpoint.
 *
 * embed()    → POST /api/embeddings  (nomic-embed-text by default)
 * classify() → POST /api/chat        (qwen3.5:4b by default, format=json)
 *
 * Network/HTTP failure maps to LLMUnreachableError so RecallService can
 * degrade to keyword mode without crashing. Classification parse failures
 * resolve to null (caller's choice whether to retry or route to inbox).
 *
 * Layering: this file lives in the outer ring. core/ depends on LLMClient,
 * not on this concrete class. Tests can substitute a fake client.
 */

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
  WorkstreamCandidateHint,
} from "@ports/llm-client.js";
import { ClassifierSchemaError, LLMUnreachableError } from "@ports/llm-client.js";
import { classifierNeedsThinkDisabled } from "./model-quirks.js";
import { buildNamingSystemPrompt, parseLongestLabel } from "./naming.js";
import { classifyWithRetry, parseClassifierContent, rewriteTimeoutMs } from "./client-shared.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_JSON_SCHEMA,
  buildUserPrompt,
} from "@core/classifier/prompt.js";
import { REWRITE_SYSTEM_PROMPT, parseRewriteJson } from "@core/recall/rewrite-prompt.js";

export type FetchImpl = typeof fetch;

// Tried raising 8000 → 28000 on 2026-05-25 to recover the answer-tail of
// long gold sessions (median LongMemEval-S gold body is 14,294 chars). The
// Ollama /api/embeddings endpoint returned 500 on 54% of those large
// inputs despite nomic-embed-text's nominal 8192-token context — semantic
// R@5 collapsed from 87.2% → 15.8%. Reverted. Real fix is chunk + max-pool
// (each body split into ≤8K-char chunks, store all vectors, score against
// max cosine at query time) so coverage doesn't depend on a single embed
// call. Filed as #174.
export const MAX_EMBED_CHARS = 8_000;

export const EMBED_PREFIXES: Record<EmbeddingKind, string> = {
  query: "search_query: ",
  document: "search_document: ",
};

export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    sumSq += v * v;
  }
  if (sumSq === 0) return vec;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly embedModel?: string;
  readonly classifyModel?: string;
  readonly timeoutMs?: number;
  readonly classifyTimeoutMs?: number;
  /**
   * Ollama context window for classify/rewrite. Ollama defaults num_ctx to
   * 4096; the classifier prompt for a median session is ~4.5K tokens, so the
   * default silently HTTP-400s every long session. Sized to cover a 20K-char
   * body plus system prompt and JSON output headroom.
   */
  readonly numCtx?: number;
  /**
   * Disable extended chain-of-thought thinking for models that support it
   * (e.g. qwen3.5:4b). Passed as top-level `think: false` in the Ollama
   * /api/chat request body. When omitted, Ollama uses the model's default
   * (thinking ON for thinking-capable models, which causes 30–180s latency
   * even on trivial prompts and triggers timeouts on the 180s classify wall).
   * Set to false for qwen3.5 variants; leave unset for the incumbent.
   */
  readonly think?: boolean;
  /** Inject a fake fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: FetchImpl;
  /** Total classify attempts before giving up on transient schema/unreachable errors. */
  readonly classifyAttempts?: number;
}

interface EmbeddingsResponse {
  readonly embedding?: ReadonlyArray<number>;
}

interface ChatResponse {
  readonly message?: { readonly content?: string };
}

export class OllamaClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly classifyModel: string;
  private readonly timeoutMs: number;
  private readonly classifyTimeoutMs: number;
  private readonly numCtx: number;
  private readonly think: boolean | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly classifyAttempts: number;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.embedModel = opts.embedModel ?? "nomic-embed-text";
    this.classifyModel = opts.classifyModel ?? "qwen3.5:4b";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
    this.numCtx = opts.numCtx ?? 16_384;
    this.think = opts.think;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.classifyAttempts = opts.classifyAttempts ?? 3;
  }

  async embed(text: string, kind: EmbeddingKind): Promise<EmbedResult> {
    // nomic-embed-text v1.5 is an asymmetric retrieval model. The
    // search_query:/search_document: prefix is part of the training
    // contract; omitting it or using the wrong one degrades retrieval
    // quality measurably. MAX_EMBED_CHARS matches the Python ceiling.
    const truncated = text.slice(0, MAX_EMBED_CHARS);
    const prompt = `${EMBED_PREFIXES[kind]}${truncated}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, prompt }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("ollama", `status ${res.status}`);
      }
      const data = (await res.json()) as EmbeddingsResponse;
      if (!data.embedding || data.embedding.length === 0) {
        throw new LLMUnreachableError("ollama", "empty embedding");
      }
      const raw = new Float32Array(data.embedding);
      return { vector: l2Normalize(raw), model: this.embedModel };
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("ollama", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async classify(transcript: string, priorContext: string = ""): Promise<ClassifyResult> {
    return classifyWithRetry(this.classifyAttempts, () => this.classifyOnce(transcript, priorContext));
  }

  private async classifyOnce(transcript: string, priorContext: string): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    try {
      const userPrompt = buildUserPrompt(transcript, priorContext);
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: CLASSIFIER_JSON_SCHEMA,
          keep_alive: 0,
          ...(this.think !== undefined ? { think: this.think } : {}),
          options: { temperature: 0.1, num_ctx: this.numCtx },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("ollama", `status ${res.status}`);
      }
      const data = (await res.json()) as ChatResponse;
      return parseClassifierContent(data.message?.content ?? "", "ollama");
    } catch (e) {
      if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError) throw e;
      throw new LLMUnreachableError("ollama", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async rewriteForRecall(query: string): Promise<RewriteResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rewriteTimeoutMs());
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: REWRITE_SYSTEM_PROMPT },
            { role: "user", content: query },
          ],
          stream: false,
          format: "json",
          keep_alive: 0,
          ...(this.think !== undefined ? { think: this.think } : {}),
          options: { temperature: 0.1, num_ctx: this.numCtx },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new LLMUnreachableError("ollama-rewrite", `status ${res.status}`);
      const data = (await res.json()) as ChatResponse;
      const rawContent = data.message?.content?.trim() ?? "";
      return parseRewriteJson(rawContent, "ollama");
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("ollama-rewrite", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async nameWorkstream(
    content: string,
    candidates: ReadonlyArray<WorkstreamCandidateHint>,
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    const sys = buildNamingSystemPrompt(candidates);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    const needsThinkOff = classifierNeedsThinkDisabled(this.classifyModel);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: sys },
            { role: "user", content },
          ],
          stream: false,
          ...(needsThinkOff ? { think: false } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as ChatResponse;
      const out = data.message?.content ?? "";
      return parseLongestLabel(out, candidates);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

