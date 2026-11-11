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
import { DEFAULT_CLASSIFY_MAX_TOKENS } from "@core/classifier/tuning.js";
import { buildNamingSystemPrompt, parseLongestLabel } from "./naming.js";
import { classifyWithRetry, parseClassifierContent, rewriteTimeoutMs } from "./client-shared.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildUserPrompt,
} from "@core/classifier/prompt.js";
import { REWRITE_SYSTEM_PROMPT, parseRewriteJson } from "@core/recall/rewrite-prompt.js";

export type FetchImpl = typeof fetch;

export interface DeepSeekClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /**
   * Optional second base URL for the same OpenAI-compatible endpoint (e.g. a
   * Tailscale fallback beside a LAN primary). Classify retries once against
   * it on network errors and HTTP 5xx from the primary; 4xx and schema errors
   * are not eligible and fail fast.
   */
  readonly fallbackBaseUrl?: string;
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
  /** Extra top-level fields merged into every chat request body (e.g.
   *  `chat_template_kwargs` to switch thinking off on an OpenAI-compatible gateway). */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
}

/**
 * Whether a failed primary classify attempt is worth retrying against the
 * fallback base: network-level failures (fetch throw, timeout abort) and HTTP
 * 5xx (the gateway's shape when its backend tunnel is down). HTTP 4xx (auth,
 * bad request) and schema errors fail the same way on any base, so they are
 * not eligible.
 */
function isFailoverEligible(error: unknown): boolean {
  if (!(error instanceof LLMUnreachableError)) return false;
  const match = /status (\d{3})/.exec(String(error.cause ?? error.message));
  if (!match) return true;
  const status = Number(match[1]);
  return status < 400 || status >= 500;
}

export class DeepSeekClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fallbackBaseUrl: string | undefined;
  private readonly classifyModel: string;
  private readonly classifyTimeoutMs: number;
  private readonly maxTranscriptChars: number;
  private readonly fetchImpl: FetchImpl;
  private readonly classifyAttempts: number;
  private readonly responseFormat: "json_object" | "none";
  private readonly classifyMaxTokens: number;
  private readonly extraBody: Readonly<Record<string, unknown>>;

  constructor(opts: DeepSeekClientOptions = {}) {
    const key = opts.apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!key) {
      throw new Error(
        "DEEPSEEK_API_KEY not set. Export it, place it in ~/.nlm/.env, or pass apiKey explicitly.",
      );
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
    this.fallbackBaseUrl = opts.fallbackBaseUrl?.replace(/\/+$/, "");
    this.classifyModel = opts.classifyModel ?? "deepseek-v4-flash";
    this.classifyTimeoutMs = opts.classifyTimeoutMs ?? 180_000;
    this.maxTranscriptChars = opts.maxTranscriptChars ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.classifyAttempts = opts.classifyAttempts ?? 3;
    this.responseFormat = opts.responseFormat ?? "json_object";
    this.classifyMaxTokens = opts.classifyMaxTokens ?? DEFAULT_CLASSIFY_MAX_TOKENS;
    this.extraBody = opts.extraBody ?? {};
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

  async classify(transcript: string, opts: { signal?: AbortSignal; priorContext?: string } = {}): Promise<ClassifyResult> {
    return classifyWithRetry(this.classifyAttempts, () => this.classifyOnce(transcript, opts.priorContext ?? "", opts.signal), opts.signal);
  }

  private async classifyOnce(transcript: string, priorContext: string, caller?: AbortSignal): Promise<ClassifyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    caller?.addEventListener("abort", () => controller.abort(), { once: true });
    if (caller?.aborted) controller.abort();
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

      try {
        return await this.postClassify(this.baseUrl, userPrompt, controller.signal);
      } catch (e) {
        if (this.fallbackBaseUrl && isFailoverEligible(e)) {
          return await this.postClassify(this.fallbackBaseUrl, userPrompt, controller.signal);
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError) throw e;
      throw new LLMUnreachableError("deepseek", e);
    } finally {
      clearTimeout(timer);
    }
  }

  private async postClassify(
    baseUrl: string,
    userPrompt: string,
    signal: AbortSignal,
  ): Promise<ClassifyResult> {
    try {
      const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
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
          ...this.extraBody,
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
        signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError(
          "deepseek",
          `status ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as ChatResponse;
      return parseClassifierContent(data.choices?.[0]?.message?.content ?? "", "deepseek");
    } catch (e) {
      if (e instanceof LLMUnreachableError || e instanceof ClassifierSchemaError) throw e;
      throw new LLMUnreachableError("deepseek", e);
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
          ...this.extraBody,
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

  async complete(system: string, user: string, opts: { signal?: AbortSignal; maxTokens?: number; model?: string; enable_thinking?: boolean } = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    // Per-call enable_thinking:false merges the gateway thinking-off switch
    // over construction-time extraBody (the dream lane passes false
    // explicitly); any other value leaves the constructed body untouched.
    const thinkOverride =
      opts.enable_thinking === false
        ? {
            chat_template_kwargs: {
              ...((this.extraBody["chat_template_kwargs"] as Record<string, unknown> | undefined) ?? {}),
              enable_thinking: false,
            },
          }
        : {};
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: opts.model ?? this.classifyModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...this.responseFormatField(),
          ...this.extraBody,
          ...thinkOverride,
          temperature: 0,
          max_tokens: opts.maxTokens ?? this.classifyMaxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMUnreachableError("deepseek-complete", `status ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const data = (await res.json()) as ChatResponse;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      if (e instanceof LLMUnreachableError) throw e;
      throw new LLMUnreachableError("deepseek-complete", e);
    } finally {
      clearTimeout(timer);
    }
  }

  async nameWorkstream(
    content: string,
    candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>,
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    const sys = buildNamingSystemPrompt(candidates, { noThinkSuffix: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.classifyModel,
          temperature: 0,
          max_tokens: this.classifyMaxTokens,
          ...this.extraBody,
          messages: [
            { role: "system", content: sys },
            { role: "user", content },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const out = data.choices?.[0]?.message?.content ?? "";
      return parseLongestLabel(out, candidates);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
