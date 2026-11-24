/**
 * WritingSampleStore — the only way core/ reads or writes the voice corpus.
 *
 * Sibling to CodeExemplarStore: append-only, idempotent on a deterministic id
 * (the same normalised text in the same install/scope/voice/channel/source is
 * a no-op), no supersedence. The vec lane is optional — inserts succeed
 * without an embedding, and recall degrades to newest-first when the lane is
 * empty (that fallback lives in the recall piece, not here).
 *
 * Tenancy follows code exemplars exactly: every method takes `tenantId` as its
 * non-optional first parameter, every read and write routes its WHERE fragment
 * through `tenantClause`, and `install_scope` is stamped server-side — it is
 * deliberately absent from WritingSampleInput so a caller cannot choose it.
 *
 * Design: docs/superpowers/specs/2026-11-23-voice-memory-phase1-design.md §A.
 */

export type WritingSampleOutcome = "published" | "approved" | "rejected" | "pending_review";
export type WritingSampleSource = "published" | "approved" | "import" | "onboarding";

/** One piece of writing as the consumer saw it. `install_scope` is not here: the store stamps it. */
export interface WritingSampleInput {
  readonly voice: string;
  readonly channel: string;
  readonly audience?: string | null;
  readonly source: WritingSampleSource;
  /** URL or upstream record id — provenance only, never embedded. */
  readonly sourceRef?: string | null;
  /** The person's own words. */
  readonly text: string;
  /** What the text replied to. Provenance for a human reader; never embedded. */
  readonly context?: string | null;
  readonly outcome: WritingSampleOutcome;
  readonly draftId?: string | null;
  readonly sessionId?: string | null;
  readonly rulesVersion?: string | null;
  /** When it was written or published (caller's clock, ISO-8601). */
  readonly ts: string;
}

/** One newest-first hit: the sample with no query vector, so no distance. */
export interface WritingSampleLatestHit extends Omit<WritingSampleHit, "distance"> {
  readonly distance: number | null;
}

/** One recall hit: the sample plus its distance from the query vector. */
export interface WritingSampleHit {
  readonly id: string;
  readonly voice: string;
  readonly channel: string;
  readonly source: WritingSampleSource;
  readonly outcome: WritingSampleOutcome;
  readonly text: string;
  readonly sourceRef: string | null;
  readonly ts: string;
  readonly distance: number;
}

/**
 * Recall filter. `channel` omitted means "any channel of this voice", which is
 * how recall falls back when the requested channel has fewer than k hits.
 * `outcomes` is what the caller is willing to surface — `pending_review` never
 * reaches recall, and rejected samples are requested separately as "avoid".
 */
export interface WritingSampleSearchFilter {
  readonly voice: string;
  readonly channel?: string;
  readonly outcomes: readonly WritingSampleOutcome[];
  /** Number of results to return. Clamped to 1..50 by both backends. */
  readonly k: number;
}

/** A stored sample that still needs a vector (retry sweep input). */
export interface WritingSampleMissing {
  readonly id: string;
  readonly text: string;
}

export interface WritingSampleStore {
  /** Insert one sample. `skipped` means the same id was already stored. */
  insert(tenantId: string, input: WritingSampleInput): Promise<{ id: string; skipped: boolean }>;

  /** Insert or update the embedding for a sample id. No-op if the sample isn't owned by tenantId. */
  upsertEmbedding(tenantId: string, id: string, vector: Float32Array): Promise<void>;

  /** Samples with no vector yet, oldest first, at most `limit`. */
  missingEmbeddings(tenantId: string, limit: number): Promise<ReadonlyArray<WritingSampleMissing>>;

  /**
   * Vector search over the tenant's samples. SQLite runs it on the semantic
   * read worker when one exists (T1770) — never a vector scan on the main loop.
   */
  search(
    tenantId: string,
    queryVector: Float32Array,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleHit>>;

  /**
   * Newest-first read over the tenant's samples, no vector needed. Recall
   * falls back to this when no embedder is reachable (design §D.4): the
   * newest published samples of the channel, `distance` always null.
   */
  latest(
    tenantId: string,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleLatestHit>>;

  /**
   * Hard-delete every sample of the tenant whose `source_ref` is in `refs`,
   * together with its vector, in one transaction; returns the rows deleted.
   * The way out for rows an import mislabelled as the person's writing —
   * refs that match nothing are a no-op, and another tenant's rows sharing a
   * `source_ref` are never touched. Callers bound `refs` (the HTTP endpoint
   * accepts at most 1000 per call); the port does not truncate.
   */
  retireByRefs(tenantId: string, refs: readonly string[]): Promise<number>;
}
