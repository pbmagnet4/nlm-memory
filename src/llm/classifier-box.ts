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
import { DeepSeekClient } from "./deepseek-client.js";
import { OllamaClient } from "./ollama-client.js";

export type ClassifierProvider = "deepseek" | "ollama" | "openai";

/** Qwen 3.5+ models default to extended chain-of-thought, which blows the
 * classify timeout. Disable thinking for them; non-thinking models like
 * qwen3:4b-instruct are unaffected. */
export function classifierNeedsThinkDisabled(model: string): boolean {
  return /qwen3\.5/i.test(model);
}

export interface ClassifierBoxOptions {
  readonly provider: ClassifierProvider;
  readonly model: string;
  readonly ollamaUrl?: string;
  /** Base URL for the `openai` provider (any OpenAI-compatible endpoint,
   *  local or cloud), e.g. http://localhost:1234/v1 (LM Studio). */
  readonly baseUrl?: string;
  /** API key for the `openai` provider. Optional — local servers ignore it,
   *  so a placeholder is sent when unset rather than failing keyless setups. */
  readonly apiKey?: string;
  /** Classify output-token budget for the `openai` provider (reasoning + JSON). */
  readonly maxTokens?: number;
}

export class ClassifierBox implements LLMClient {
  private inner: LLMClient;
  private providerName: ClassifierProvider;
  private modelName: string;
  private readonly ollamaUrl: string;
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number | undefined;

  constructor(opts: ClassifierBoxOptions) {
    this.providerName = opts.provider;
    this.modelName = opts.model;
    this.ollamaUrl = opts.ollamaUrl ?? "http://localhost:11434";
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens;
    this.inner = this.construct(opts.provider, opts.model);
  }

  get provider(): ClassifierProvider { return this.providerName; }
  get model(): string { return this.modelName; }

  swap(provider: ClassifierProvider, model: string): void {
    this.inner = this.construct(provider, model);
    this.providerName = provider;
    this.modelName = model;
  }

  embed(_text: string, _kind: EmbeddingKind): Promise<EmbedResult> {
    throw new Error("ClassifierBox.embed is not supported — wire OllamaClient as the embedder.");
  }

  classify(transcript: string): Promise<ClassifyResult> {
    return this.inner.classify(stripInjectedContext(transcript));
  }

  rewriteForRecall(query: string): Promise<RewriteResult> {
    return this.inner.rewriteForRecall(query);
  }

  nameWorkstream(content: string, candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>): Promise<string | null> {
    return this.inner.nameWorkstream(content, candidates);
  }

  private construct(provider: ClassifierProvider, model: string): LLMClient {
    if (provider === "ollama") {
      return new OllamaClient({ baseUrl: this.ollamaUrl, classifyModel: model, ...(classifierNeedsThinkDisabled(model) ? { think: false } : {}) });
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
      // servers. Thinking can't be disabled via API on those engines, so we
      // give max_tokens headroom rather than fight the model's CoT.
      return new DeepSeekClient({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey ?? "local",
        classifyModel: model,
        responseFormat: "none",
        ...(this.maxTokens ? { classifyMaxTokens: this.maxTokens } : {}),
      });
    }
    return new DeepSeekClient({ classifyModel: model });
  }
}
