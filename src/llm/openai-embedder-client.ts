/**
 * OpenAIEmbedderClient — an embedder backed by any OpenAI-compatible
 * `/v1/embeddings` endpoint (LM Studio, oMLX, vLLM, or a cloud API). It mirrors
 * OllamaClient's embedding contract exactly so vectors are interchangeable:
 * the same nomic asymmetric-retrieval prefixes (`search_query:` /
 * `search_document:`), the same MAX_EMBED_CHARS truncation, and the same
 * L2-normalization. Only the transport differs (POST `/embeddings` with
 * `{model, input}` and a `data[0].embedding` response shape).
 *
 * This client only embeds. `classify()` and `rewriteForRecall()` are not
 * supported and throw LLMUnreachableError so a RecallService that holds this as
 * its `llm` fails open to the raw query rather than crashing.
 */

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
} from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import { EMBED_PREFIXES, MAX_EMBED_CHARS, l2Normalize } from "./ollama-client.js";

export type FetchImpl = typeof fetch;

/** Default model for the openai embedder provider — nomic-embed-text v1.5 as
 *  served by LM Studio (`/v1/embeddings`). Exported so the info descriptor
 *  reports the same default the client actually uses. */
export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";

export interface OpenAIEmbedderClientOptions {
  readonly baseUrl: string;
  readonly model?: string;
  /** Optional — local servers ignore it; a placeholder is sent when unset. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchImpl;
}

interface EmbeddingsResponse {
  readonly data?: ReadonlyArray<{ readonly embedding?: ReadonlyArray<number> }>;
}

export class OpenAIEmbedderClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OpenAIEmbedderClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_OPENAI_EMBED_MODEL;
    this.apiKey = opts.apiKey ?? "local";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(text: string, kind: EmbeddingKind, opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    const input = `${EMBED_PREFIXES[kind]}${text.slice(0, MAX_EMBED_CHARS)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternal = opts?.signal != null ? (): void => { controller.abort(); } : null;
    if (onExternal != null && opts?.signal != null) {
      opts.signal.addEventListener("abort", onExternal, { once: true });
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("openai-embedder", `status ${res.status}`);
      }
      const data = (await res.json()) as EmbeddingsResponse;
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || embedding.length === 0) {
        throw new LLMUnreachableError("openai-embedder", "empty embedding");
      }
      return { vector: l2Normalize(new Float32Array(embedding)), model: this.model };
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("openai-embedder", e);
    } finally {
      clearTimeout(timer);
      if (onExternal != null && opts?.signal != null) {
        opts.signal.removeEventListener("abort", onExternal);
      }
    }
  }

  async classify(_transcript: string): Promise<ClassifyResult> {
    throw new LLMUnreachableError(
      "openai-embedder",
      "classify not supported — OpenAIEmbedderClient is an embedder only",
    );
  }

  async rewriteForRecall(_query: string): Promise<RewriteResult> {
    throw new LLMUnreachableError(
      "openai-embedder",
      "rewriteForRecall not supported — OpenAIEmbedderClient is an embedder only",
    );
  }

  nameWorkstream(): Promise<string | null> {
    throw new Error("OpenAIEmbedderClient does not support nameWorkstream");
  }
}
