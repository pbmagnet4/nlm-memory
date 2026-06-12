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
import { DeepSeekClient } from "./deepseek-client.js";
import { OllamaClient } from "./ollama-client.js";

export type ClassifierProvider = "deepseek" | "ollama";

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
}

export class ClassifierBox implements LLMClient {
  private inner: LLMClient;
  private providerName: ClassifierProvider;
  private modelName: string;
  private readonly ollamaUrl: string;

  constructor(opts: ClassifierBoxOptions) {
    this.providerName = opts.provider;
    this.modelName = opts.model;
    this.ollamaUrl = opts.ollamaUrl ?? "http://localhost:11434";
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
    return this.inner.classify(transcript);
  }

  rewriteForRecall(query: string): Promise<RewriteResult> {
    return this.inner.rewriteForRecall(query);
  }

  private construct(provider: ClassifierProvider, model: string): LLMClient {
    if (provider === "ollama") {
      return new OllamaClient({ baseUrl: this.ollamaUrl, classifyModel: model, ...(classifierNeedsThinkDisabled(model) ? { think: false } : {}) });
    }
    return new DeepSeekClient({ classifyModel: model });
  }
}
