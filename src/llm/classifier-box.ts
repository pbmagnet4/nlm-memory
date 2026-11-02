/**
 * ClassifierBox — a mutable LLMClient wrapper holding the active classifier
 * client. The scheduler reads `inner` on each tick, so a runtime swap takes
 * effect on the next session ingest without restarting the daemon.
 *
 * Only `classify()` is delegated. `embed()` throws — embeddings are wired
 * separately through the dedicated Ollama embedder; the classifier slot is
 * for transcript classification only.
 */

import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
} from "@ports/llm-client.js";
import { stripInjectedContext } from "@core/hook/strip-injected-context.js";
import { NO_STORED_SETTINGS, resolveClassifierTuning, type ClassifierTuning } from "@core/classifier/tuning.js";
import { DeepSeekClient, type FetchImpl } from "./deepseek-client.js";
import { OllamaClient } from "./ollama-client.js";

export type ClassifierProvider = "deepseek" | "ollama" | "openai";

export interface ClassifierBoxOptions {
  readonly provider: ClassifierProvider;
  readonly model: string;
  readonly ollamaUrl?: string;
  /** Base URL for the `openai` provider (any OpenAI-compatible endpoint,
   *  local or cloud), e.g. http://localhost:1234/v1 (LM Studio). */
  readonly baseUrl?: string;
  /** Optional second base URL for the `openai` provider (e.g. a Tailscale
   *  fallback beside a LAN primary). Classify retries once against it on
   *  network errors and HTTP 5xx from the primary. */
  readonly fallbackBaseUrl?: string;
  /** API key for the `openai` provider. Optional — local servers ignore it,
   *  so a placeholder is sent when unset rather than failing keyless setups. */
  readonly apiKey?: string;
  /** Resolved tuning (thinking, timeout, max tokens). Defaults to the built-in
   *  defaults, ignoring env — callers that honor env/settings resolve first. */
  readonly tuning?: ClassifierTuning;
  /** Inject a fake fetch for tests. */
  readonly fetchImpl?: FetchImpl;
}

export class ClassifierBox implements LLMClient {
  private inner: LLMClient;
  private providerName: ClassifierProvider;
  private modelName: string;
  private readonly ollamaUrl: string;
  private readonly baseUrl: string | undefined;
  private readonly fallbackBaseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchImpl | undefined;
  private tuningState: ClassifierTuning;

  constructor(opts: ClassifierBoxOptions) {
    this.providerName = opts.provider;
    this.modelName = opts.model;
    this.ollamaUrl = opts.ollamaUrl ?? "http://localhost:11434";
    this.baseUrl = opts.baseUrl;
    this.fallbackBaseUrl = opts.fallbackBaseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl;
    this.tuningState = opts.tuning ?? resolveClassifierTuning(NO_STORED_SETTINGS, {});
    this.inner = this.construct(opts.provider, opts.model, this.tuningState);
  }

  get provider(): ClassifierProvider { return this.providerName; }
  get model(): string { return this.modelName; }
  /** Whether the 'openai' provider (any OpenAI-compatible endpoint, e.g. LM
   *  Studio) can be swapped to at runtime — it rides the baseUrl fixed at
   *  daemon startup, so swapping is only model selection, not endpoint
   *  selection. */
  get openAiSwapAvailable(): boolean { return this.baseUrl !== undefined; }

  get tuning(): ClassifierTuning { return this.tuningState; }
  /** Per-call classify timeout; the scheduler reads this on every call. */
  get timeoutMs(): number { return this.tuningState.timeoutMs.value; }

  /** Rebuild the inner client in place with new tuning (same pattern as swap). */
  retune(tuning: ClassifierTuning): void {
    this.inner = this.construct(this.providerName, this.modelName, tuning);
    this.tuningState = tuning;
  }

  swap(provider: ClassifierProvider, model: string): void {
    this.inner = this.construct(provider, model, this.tuningState);
    this.providerName = provider;
    this.modelName = model;
  }

  embed(_text: string, _kind: EmbeddingKind): Promise<EmbedResult> {
    throw new Error("ClassifierBox.embed is not supported — wire OllamaClient as the embedder.");
  }

  classify(transcript: string, opts?: { signal?: AbortSignal }): Promise<ClassifyResult> {
    return this.inner.classify(stripInjectedContext(transcript), opts);
  }

  rewriteForRecall(query: string): Promise<RewriteResult> {
    return this.inner.rewriteForRecall(query);
  }

  complete(system: string, user: string, opts?: { signal?: AbortSignal; maxTokens?: number }): Promise<string> {
    if (!this.inner.complete) throw new Error(`classifier provider ${this.providerName} has no chat completion`);
    return this.inner.complete(system, user, opts);
  }

  nameWorkstream(content: string, candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>): Promise<string | null> {
    return this.inner.nameWorkstream(content, candidates);
  }

  private construct(provider: ClassifierProvider, model: string, tuning: ClassifierTuning): LLMClient {
    const classifyTimeoutMs = tuning.timeoutMs.value;
    const thinkingOff = tuning.thinking.value === "off";
    const fetchImpl = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};
    // The client default token budget applies unless a setting or env set one.
    const maxTokens = tuning.maxTokens.source === "default" ? {} : { classifyMaxTokens: tuning.maxTokens.value };
    if (provider === "ollama") {
      return new OllamaClient({ baseUrl: this.ollamaUrl, classifyModel: model, classifyTimeoutMs, ...(thinkingOff ? { think: false } : {}), ...fetchImpl });
    }
    if (provider === "openai") {
      if (!this.baseUrl) {
        throw new Error(
          "classifier provider 'openai' requires a baseUrl (set NLM_CLASSIFIER_BASE_URL), " +
            "e.g. http://localhost:1234/v1 for LM Studio.",
        );
      }
      // The openai provider rides DeepSeekClient (a generic OpenAI-compatible
      // client). response_format is omitted because some local engines (LM
      // Studio MLX) reject json_object; a placeholder key covers keyless local
      // servers. Thinking off is `chat_template_kwargs.enable_thinking=false`,
      // the switch vLLM/LiteLLM-style gateways honor.
      return new DeepSeekClient({
        baseUrl: this.baseUrl,
        ...(this.fallbackBaseUrl ? { fallbackBaseUrl: this.fallbackBaseUrl } : {}),
        apiKey: this.apiKey ?? "local",
        classifyModel: model,
        responseFormat: "none",
        classifyTimeoutMs,
        ...maxTokens,
        ...(thinkingOff ? { extraBody: { chat_template_kwargs: { enable_thinking: false } } } : {}),
        ...fetchImpl,
      });
    }
    // deepseek cloud API has no thinking switch: nothing is sent for either mode.
    return new DeepSeekClient({ classifyModel: model, classifyTimeoutMs, ...maxTokens, ...fetchImpl });
  }
}
