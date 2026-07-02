/**
 * DeepSeekClient — LLMClient backed by DeepSeek's OpenAI-compatible chat API.
 *
 * Use case (per Python notes confirmed 2026-05-07 / 2026-05-13):
 *   • v4-flash handles inputs up to ~60K chars reliably; we cap at 30K to
 *     stay well inside the deterministic zone.
 *   • ~$0.002/session at typical sizes — full backfill of ~1,200 sessions
 *     ≈ $2.50.
 *   • Strong extraction quality (12+ entities, accurate decisions,
 *     0.9 confidence). The 2026-06-02 head-to-head bench found qwen3:4b
 *     statistically tied on schema validity and entity counts at $0/local;
 *     DeepSeek remains the speed/throughput pick.
 *
 * Same prompt module as OllamaClient — only the transport differs. Same
 * error semantics: LLMUnreachableError for network/HTTP, ClassifierSchemaError
 * for unparseable / shape-wrong output. Reads DEEPSEEK_API_KEY at construct
 * time unless an explicit key is passed.
 *
 * Embedding is not supported by DeepSeek's API — `embed()` throws. Wire a
 * separate embedder (OllamaClient) for semantic recall.
 */

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
} from "@ports/llm-client.js";
import { ClassifierSchemaError, LLMUnreachableError } from "@ports/llm-client.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildUserPrompt,
  coerceClassifyResult,
  stripJsonFences,
  validateClassifierJson,
} from "@core/classifier/prompt.js";
import { REWRITE_SYSTEM_PROMPT, parseRewriteJson } from "@core/recall/rewrite-prompt.js";

const DEFAULT_REWRITE_TIMEOUT_MS = 5_000;
function rewriteTimeoutMs(): number {
  const raw = process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  if (!raw) return DEFAULT_REWRITE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REWRITE_TIMEOUT_MS;
}

export type FetchImpl = typeof fetch;

export interface DeepSeekClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly classifyModel?: string;
  readonly classifyTimeoutMs?: number;
  readonly maxTranscriptChars?: number;
  readonly fetchImpl?: FetchImpl;
  /** Total classify attempts before giving up on transient schema/unreachable errors. */
  readonly classifyAttempts?: number;
  /**
   * Whether to request structured JSON via `response_format`. DeepSeek and many
   * cloud OpenAI-compatible APIs accept `json_object`; some local servers reject
   * it (LM Studio's MLX engine demands `json_schema` or `text`). `"none"` omits
   * the field entirely — the most portable choice across arbitrary endpoints —
   * and relies on the system prompt + fence-stripping + schema validation.
   */
  readonly responseFormat?: "json_object" | "none";
  /**
   * Output token budget for classify. Must cover the model's hidden reasoning
   * plus the JSON body. Thinking-capable local models (e.g. qwen3.5 over an
   * OpenAI-compatible endpoint, where think cannot be disabled via API) consume
   * 1-2K+ reasoning tokens before any JSON, so this needs headroom.
   */
  readonly classifyMaxTokens?: number;
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
}

export class DeepSeekClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly classifyModel: string;
  private readonly classifyTimeoutMs: number;
  private readonly maxTranscriptChars: number;
  private readonly fetchImpl: FetchImpl;
  private readonly classifyAttempts: number;
  private readonly responseFormat: "json_object" | "none";
  private readonly classifyMaxTokens: number;

  constructor(opts: DeepSeekClientOptions = {}) {
    const key = opts.apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!key) {
      throw new Error(
        "DEEPSEEK_API_KEY not set. Export it, place it in ~/.nlm/.env, or pass apiKey explicitly.",
      );
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
    this.classifyModel = opts.classifyModel ?? "deepseek-v4-flash";
    this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
    this.maxTranscriptChars = opts.maxTranscriptChars ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.classifyAttempts = opts.classifyAttempts ?? 3;
    this.responseFormat = opts.responseFormat ?? "json_object";
    this.classifyMaxTokens = opts.classifyMaxTokens ?? 8192;
  }

  /** Spread into a chat request body: `{type:"json_object"}` or nothing. */
  private responseFormatField(): Record<string, unknown> {
    return this.responseFormat === "json_object"
      ? { response_format: { type: "json_object" } }
      : {};
  }

  async embed(_text: string, _kind: EmbeddingKind): Promise<EmbedResult> {
    throw new Error(
      "DeepSeekClient.embed not supported — DeepSeek's API has no embeddings endpoint. Wire OllamaClient for embeddings.",
    );
  }

  async classify(transcript: string, priorContext: string = ""): Promise<ClassifyResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.classifyAttempts; attempt++) {
      try {
        return await this.classifyOnce(transcript, priorContext);
      } catch (e) {
        if (!(e instanceof ClassifierSchemaError || e instanceof LLMUnreachableError)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  private async classifyOnce(transcript: string, priorContext: string): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    try {
      // DeepSeek's reliable zone is ≤30K, narrower than the prompt module's
      // 15K default. We pre-truncate to our wider cap to feed the model more
      // context than Ollama can handle, then buildUserPrompt's own truncation
      // is a no-op.
      const sized =
        transcript.length <= this.maxTranscriptChars
          ? transcript
          : transcript.slice(0, this.maxTranscriptChars / 2 - 40) +
            "\n\n[... transcript truncated; below is the closing portion ...]\n\n" +
            transcript.slice(transcript.length - this.maxTranscriptChars / 2 + 40);
      const userPrompt = buildUserPrompt(sized, priorContext);

      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          ...this.responseFormatField(),
          temperature: 0.1,
          // max_tokens covers reasoning + JSON output. Reasoning models (e.g.
          // deepseek-v4-flash, or qwen3.5 over an OpenAI-compatible endpoint
          // where think can't be disabled) spend hidden chain-of-thought
          // against this budget before any JSON reaches `content`. At 1024 the
          // reasoning consumed the entire budget and content came back empty
          // (finish_reason: length). Default 8192 leaves headroom; tune via
          // classifyMaxTokens for models with longer reasoning.
          max_tokens: this.classifyMaxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError(
          "deepseek",
          `status ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as ChatResponse;
      const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
      const content = stripJsonFences(rawContent);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new ClassifierSchemaError("deepseek returned non-JSON content");
      }
      if (!validateClassifierJson(parsed)) {
        throw new ClassifierSchemaError("deepseek response missing required keys");
      }
      return coerceClassifyResult(parsed);
    } catch (e) {
      if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError) throw e;
      throw new LLMUnreachableError("deepseek", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async rewriteForRecall(query: string): Promise<RewriteResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rewriteTimeoutMs());
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.classifyModel,
          messages: [
            { role: "system", content: REWRITE_SYSTEM_PROMPT },
            { role: "user", content: query },
          ],
          ...this.responseFormatField(),
          temperature: 0.1,
          max_tokens: 512,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError(
          "deepseek-rewrite",
          `status ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as ChatResponse;
      const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
      return parseRewriteJson(rawContent, "deepseek");
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("deepseek-rewrite", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async nameWorkstream(
    content: string,
    candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>,
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    const list = candidates.map((c) => `- ${c.label}`).join("\n");
    const sys =
      `You label a work session by which project it belongs to. Known projects:\n${list}\n` +
      `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none". /no_think`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.classifyModel,
          temperature: 0,
          max_tokens: this.classifyMaxTokens, // covers hidden reasoning + the short answer
          messages: [
            { role: "system", content: sys },
            { role: "user", content },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null; // fail-soft: naming is best-effort, never throw into the bind path
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const out = (data.choices?.[0]?.message?.content ?? "").toLowerCase();
      // Robust parse: pick the longest candidate label that appears in the (possibly chatty) reply.
      let best: string | null = null;
      let bestLen = 0;
      for (const c of candidates) {
        if (out.includes(c.label.toLowerCase()) && c.label.length > bestLen) {
          best = c.label;
          bestLen = c.label.length;
        }
      }
      return best;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
