/**
 * LLMClient — outbound LLM calls (embedding + classification).
 *
 * Implementations: OllamaClient (default, local), AnthropicClient, OpenAIClient.
 * core/ only sees this interface; it never imports an HTTP client.
 */

export interface EmbedResult {
  readonly vector: Float32Array;
  readonly model: string;
}

export type EmbeddingKind = "query" | "document";

/**
 * Raw fact extracted by the classifier. No id, no source_session_id, no
 * created_at yet — those get filled in at ingest time by extractFacts().
 *
 * `subject` and `predicate` come from the classifier already normalized
 * (lowercased, trimmed) per the prompt contract, but the coercer re-normalizes
 * defensively because LLM output is not trustworthy.
 */
export interface ExtractedFact {
  readonly kind: "decision" | "open" | "attribute";
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly sourceQuote?: string;
}

export interface ClassifyResult {
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly confidence: number;
  readonly facts: ReadonlyArray<ExtractedFact>;
}

export class LLMUnreachableError extends Error {
  constructor(provider: string, cause?: unknown) {
    super(`LLM unreachable: ${provider}`);
    this.name = "LLMUnreachableError";
    this.cause = cause;
  }
}

export class ClassifierSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierSchemaError";
  }
}

/**
 * Result of rewriting a vague natural-language recall query into both a
 * keyword-optimized phrasing (entity-rich, suitable for FTS5 BM25) and a
 * semantic-optimized phrasing (cleaner prose, suitable for embedding).
 *
 * The keyword and semantic queries are independent — keyword strips
 * conversational filler and surfaces named entities; semantic preserves
 * paraphrasing so the embedder has something meaningful to embed.
 */
export interface RewriteResult {
  readonly keywordQuery: string;
  readonly semanticQuery: string;
  /** Free-text rationale for debugging; not used by the retrieval path. */
  readonly rationale?: string;
}

export interface WorkstreamCandidateHint {
  readonly label: string;
}

export interface LLMClient {
  embed(text: string, kind: EmbeddingKind, opts?: { signal?: AbortSignal }): Promise<EmbedResult>;
  classify(transcript: string): Promise<ClassifyResult>;
  /** Name which candidate workstream this session belongs to, or null for "none".
   *  Returns the chosen candidate.label verbatim. Content is label+summary or a transcript. */
  nameWorkstream(content: string, candidates: ReadonlyArray<WorkstreamCandidateHint>): Promise<string | null>;
  /**
   * Rewrite a recall query for better retrieval. Cheap-ish call (one-shot
   * chat completion, ~hundreds of ms locally). Implementations MUST throw
   * LLMUnreachableError on network/transport failure so callers can
   * fail-open back to the raw query. JSON-parse failures should also
   * throw LLMUnreachableError (or a more specific subclass) — the caller
   * never wants a garbage-rewritten query silently substituted.
   */
  rewriteForRecall(query: string): Promise<RewriteResult>;
}
