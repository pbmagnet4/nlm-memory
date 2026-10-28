/**
 * EmbedderBox / CodeEmbedderBox — mutable wrappers around the active embedder
 * client, so a settings write takes effect on the next embed call without
 * restarting the daemon (same idea as ClassifierBox). Consumers hold the box;
 * `swap` replaces the inner client.
 */

import type { CodeEmbedder, EmbedCodeResult } from "@ports/code-embedder.js";
import type {
  ClassifyResult,
  EmbedResult,
  EmbeddingKind,
  LLMClient,
  RewriteResult,
  WorkstreamCandidateHint,
} from "@ports/llm-client.js";

export class EmbedderBox implements LLMClient {
  constructor(private inner: LLMClient) {}

  swap(next: LLMClient): void {
    this.inner = next;
  }

  embed(text: string, kind: EmbeddingKind, opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    return this.inner.embed(text, kind, opts);
  }

  classify(transcript: string, opts?: { signal?: AbortSignal }): Promise<ClassifyResult> {
    return this.inner.classify(transcript, opts);
  }

  nameWorkstream(content: string, candidates: ReadonlyArray<WorkstreamCandidateHint>): Promise<string | null> {
    return this.inner.nameWorkstream(content, candidates);
  }

  rewriteForRecall(query: string): Promise<RewriteResult> {
    return this.inner.rewriteForRecall(query);
  }
}

export class CodeEmbedderBox implements CodeEmbedder {
  constructor(private inner: CodeEmbedder) {}

  swap(next: CodeEmbedder): void {
    this.inner = next;
  }

  embed(text: string, role: "query" | "document", signal?: AbortSignal): Promise<EmbedCodeResult> {
    return this.inner.embed(text, role, signal);
  }
}
