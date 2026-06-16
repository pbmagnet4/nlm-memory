/**
 * OllamaCodeEmbedder — CodeEmbedder backed by a local Ollama endpoint.
 *
 * Default model: hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF (146 MB Q8).
 * Override via NLM_CODE_EMBED_MODEL env var.
 *
 * CodeRankEmbed prefix convention:
 *   query    → "Represent this query for searching relevant code: <text>"
 *   document → raw text (no prefix)
 *
 * Falls back to nomic-embed-text conventions when the configured model
 * starts with "nomic" (for the graceful-degradation path).
 *
 * Vectors are L2-normalised before return so vec0 cosine retrieval is correct.
 */

import type { CodeEmbedder, EmbedCodeResult } from "@ports/code-embedder.js";
import { LLMUnreachableError } from "@ports/llm-client.js";

const DEFAULT_CODE_EMBED_MODEL = "hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF";
const CODE_RANK_QUERY_PREFIX = "Represent this query for searching relevant code: ";

function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sumSq += x * x;
  }
  if (sumSq === 0) return v;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return out;
}

export interface OllamaCodeEmbedderOptions {
  readonly baseUrl?: string;
  readonly model?: string;
}

export class OllamaCodeEmbedder implements CodeEmbedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly isNomic: boolean;

  constructor(opts: OllamaCodeEmbedderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? (process.env["OLLAMA_HOST"] ?? "http://localhost:11434");
    this.model = opts.model ?? (process.env["NLM_CODE_EMBED_MODEL"] ?? DEFAULT_CODE_EMBED_MODEL);
    this.isNomic = this.model.startsWith("nomic");
  }

  async embed(text: string, role: "query" | "document"): Promise<EmbedCodeResult> {
    const prompt = this.buildPrompt(text, role);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt }),
      });
    } catch (e) {
      throw new LLMUnreachableError("ollama-code-embedder", String(e));
    }
    if (!res.ok) {
      throw new LLMUnreachableError("ollama-code-embedder", `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding || data.embedding.length === 0) {
      throw new LLMUnreachableError("ollama-code-embedder", "empty embedding");
    }
    const raw = new Float32Array(data.embedding);
    const vector = l2Normalize(raw);
    return { vector, dim: vector.length };
  }

  private buildPrompt(text: string, role: "query" | "document"): string {
    if (this.isNomic) {
      return role === "query" ? `search_query: ${text}` : `search_document: ${text}`;
    }
    return role === "query" ? `${CODE_RANK_QUERY_PREFIX}${text}` : text;
  }
}
