/**
 * CodeEmbedder — minimal port for the code-specific embedding lane.
 *
 * Separate from LLMClient because code embedding uses different models
 * (CodeRankEmbed vs nomic-embed-text) and different prefix conventions.
 * Keeping the port focused prevents cross-contamination between the prose
 * and code vector spaces.
 *
 * Graceful degradation: when no CodeEmbedder is wired (e.g. Ollama doesn't
 * have the model), callers fall back to the prose embedder or skip the vec
 * insert. The feature flag NLM_CODE_EXEMPLARS_ENABLED controls whether the
 * lane is active at all.
 */

export interface EmbedCodeResult {
  readonly vector: Float32Array;
  /** Actual dimension of the returned vector. */
  readonly dim: number;
}

export interface CodeEmbedder {
  /**
   * Embed text for the code lane.
   *
   * `role: "query"` — apply the model's query prefix (if any).
   * `role: "document"` — embed the chunk as-is (or with a document prefix).
   *
   * `signal` — optional AbortSignal; when aborted, the implementation should
   * reject (or let the underlying fetch reject) so callers with a racing
   * timeout can cancel the in-flight Ollama request immediately rather than
   * letting it run to completion in the background.
   */
  embed(text: string, role: "query" | "document", signal?: AbortSignal): Promise<EmbedCodeResult>;
}
