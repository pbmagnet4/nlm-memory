/**
 * OpenAICodeEmbedderClient — the code-lane embedder over any OpenAI-compatible
 * `/v1/embeddings` endpoint (LM Studio, oMLX, vLLM, cloud). It mirrors
 * OllamaCodeEmbedder's contract exactly — same CodeRankEmbed/nomic prefix
 * convention (via the shared `buildCodeEmbedPrompt`) and the same
 * L2-normalization — so vectors are interchangeable with the Ollama transport.
 * Only the request/response shape differs (`{model, input}` -> `data[0].embedding`).
 */

import type { CodeEmbedder, EmbedCodeResult } from "@ports/code-embedder.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import { l2Normalize } from "./ollama-client.js";
import { DEFAULT_CODE_EMBED_MODEL, buildCodeEmbedPrompt } from "./ollama-code-embedder.js";

export type FetchImpl = typeof fetch;

export interface OpenAICodeEmbedderClientOptions {
  readonly baseUrl: string;
  readonly model?: string;
  /** Optional — local servers ignore it; a placeholder is sent when unset. */
  readonly apiKey?: string;
  readonly fetchImpl?: FetchImpl;
}

interface EmbeddingsResponse {
  readonly data?: ReadonlyArray<{ readonly embedding?: ReadonlyArray<number> }>;
}

export class OpenAICodeEmbedderClient implements CodeEmbedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OpenAICodeEmbedderClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_CODE_EMBED_MODEL;
    this.apiKey = opts.apiKey ?? "local";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(text: string, role: "query" | "document", signal?: AbortSignal): Promise<EmbedCodeResult> {
    const input = buildCodeEmbedPrompt(text, role, this.model);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new LLMUnreachableError("openai-code-embedder", String(e));
    }
    if (!res.ok) {
      throw new LLMUnreachableError("openai-code-embedder", `HTTP ${res.status}`);
    }
    const data = (await res.json()) as EmbeddingsResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new LLMUnreachableError("openai-code-embedder", "empty embedding");
    }
    const vector = l2Normalize(new Float32Array(embedding));
    return { vector, dim: vector.length };
  }
}
