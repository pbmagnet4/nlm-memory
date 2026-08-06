/**
 * FactStore — the only way core/ reads or writes the fact corpus.
 *
 * Companion to SessionStore. Sessions are the operator-recall unit; facts are
 * the agent-recall projection — normalized (subject, predicate, value) triples
 * derived from sessions, supersedence-aware. See
 * docs/plans/factstore-design.md.
 *
 * Every method takes `tenantId` as its non-optional FIRST parameter (program
 * spec §4.1, M2 plan Wave B). There is no default — the composition root
 * supplies `DEFAULT_TEAM_ID` (src/core/tenancy/default-team.ts) until M3
 * resolves the real tenant from the request's auth token.
 */

import type { Fact, FactHistoryChain, FactKind } from "@shared/types.js";

export interface FactQuery {
  readonly subject: string;
  readonly predicate?: string;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export interface FactSemanticNeighbor {
  readonly factId: string;
  readonly distance: number;
}

/**
 * Per-subject aggregate over current facts. Feeds the wiki projection's
 * page-selection stage. Returns every subject with at least one current
 * fact; threshold filtering is the caller's job so thresholds stay testable
 * without a database.
 */
export interface SubjectStat {
  readonly subject: string;
  readonly factCount: number;
  readonly sessionCount: number;
}

/** Pre-filter applied at the storage layer before keyword scoring runs. */
export interface FactListFilter {
  readonly subject?: string;
  readonly predicate?: string;
  readonly kind?: FactKind;
  readonly includeSuperseded?: boolean;
  readonly minConfidence?: number;
  readonly limit?: number;
}

export interface FactStore {
  /** Atomically insert a single fact. Throws on duplicate id. */
  insert(tenantId: string, fact: Fact): Promise<void>;

  /** Atomically insert many facts as one transaction. Throws on any duplicate id. */
  insertMany(tenantId: string, facts: ReadonlyArray<Fact>): Promise<void>;

  getById(tenantId: string, id: string): Promise<Fact | null>;

  /**
   * Batch lookup by id. Returns the facts that exist, in unspecified order;
   * missing ids are silently omitted. No supersedence/confidence filtering —
   * the caller applies its own predicate. Used by FactRecallService to resolve
   * semantic-search neighbours that fall outside the keyword candidate window.
   */
  getByIds(tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>>;

  /**
   * Exact-match lookup of the current (non-superseded) fact for a
   * subject+predicate pair. Returns null if none exists. This is the hot
   * path for deterministic supersedence on ingest (Phase B.4).
   */
  findCurrent(tenantId: string, subject: string, predicate: string): Promise<Fact | null>;

  /**
   * List facts matching the query. Defaults: current (non-superseded) only,
   * limit 50. Ordered by created_at descending.
   */
  list(tenantId: string, query: FactQuery): Promise<ReadonlyArray<Fact>>;

  /**
   * List all facts attributable to a single session. Used by the UI to show
   * a fact-count badge on a session digest, and by tests.
   */
  listBySession(tenantId: string, sessionId: string): Promise<ReadonlyArray<Fact>>;

  /**
   * Batch variant of listBySession. Returns current (non-superseded,
   * non-retired) facts across all given sessions by default. Pass
   * `opts.includeSuperseded: true` to lift that filter. Empty input
   * returns [] immediately.
   */
  listBySessions(tenantId: string, sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>>;

  /**
   * Mark `oldId` as superseded by `newId`. Both facts must exist (within the
   * caller's tenant — same not-found shape otherwise). Reversible by passing
   * null as newId (Phase C operator-undo affordance).
   */
  markSuperseded(tenantId: string, oldId: string, newId: string | null): Promise<void>;

  /**
   * Retire a fact: an operator declared it wrong or noise, with no replacement.
   * Sets `retired_at` and drops the embedding so the fact stops surfacing in
   * keyword AND semantic recall. Distinct from supersedence (which points at a
   * successor). Throws if the fact does not exist; idempotent on an
   * already-retired fact. Retired facts remain fetchable by id and via
   * getHistory / includeSuperseded so the audit trail survives.
   */
  retire(tenantId: string, factId: string): Promise<void>;

  /**
   * Insert or replace the embedding vector for a fact. Vector dimension is
   * fixed by the embedding model (nomic-embed-text → 768) and validated by
   * the adapter. Best-effort at the call site: ingest traps errors so an
   * unreachable embedder doesn't roll back the surrounding transaction.
   */
  upsertEmbedding(tenantId: string, factId: string, vector: Float32Array): Promise<void>;

  /**
   * Atomic session-scoped fact write: delete prior facts for this session,
   * insert the new set, then apply deterministic supersedence on any
   * (subject, predicate) collision against existing non-superseded facts
   * from other sessions. Must run inside a transaction (the caller wraps
   * with Storage.withTransaction). See Section 2 of factstore-design.md
   * for the ordering rationale: inserts must complete before supersedence
   * UPDATEs run, since superseded_by is an FK to facts(id).
   *
   * The SQLite adapter additionally inlines this logic inside its own
   * session-store ingest path (because better-sqlite3 txn callbacks must
   * be sync); other backends call this method via Storage.withTransaction.
   *
   * Batch-internal duplicates (two facts in the same call with the same
   * (subject, predicate)) produce implementation-defined behavior: which
   * sibling ends up current is not part of the contract. Callers must
   * dedupe within a batch if they need deterministic results.
   */
  ingestSessionFacts(
    tenantId: string,
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void>;

  /**
   * Pre-filtered fact list used by FactRecallService. Applies subject /
   * predicate / kind / confidence / superseded filters at the SQL layer
   * before keyword scoring runs in core. No ordering guarantee beyond
   * `created_at DESC`.
   */
  listForRecall(tenantId: string, filter: FactListFilter): Promise<ReadonlyArray<Fact>>;

  /**
   * sqlite-vec KNN over fact_embeddings. Returns up to `limit` nearest
   * neighbors by L2 distance, re-applying the tenant filter in the
   * id-resolution SQL (program spec §4.3 — the vector index otherwise
   * returns neighbors from the whole corpus). The service converts distance
   * to cosine and blends with keyword scores.
   */
  semanticSearch(
    tenantId: string,
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<FactSemanticNeighbor>>;

  /**
   * Supersedence chain inspection. When `predicate` is provided, returns a
   * single chain (or empty array if no facts match). When omitted, returns
   * one chain per distinct predicate for that subject. Each chain orders
   * newest → oldest by created_at.
   */
  getHistory(
    tenantId: string,
    subject: string,
    predicate?: string,
  ): Promise<ReadonlyArray<FactHistoryChain>>;

  /**
   * For each (subject, predicate, value) triple, count how many distinct
   * sessions across the full fact history (including superseded predecessors)
   * have asserted that exact value. Used by FactRecallService to boost
   * scores for facts corroborated across many sessions ("we settled on
   * DuckDB in 10 different sessions" outranks "we mentioned DuckDB once").
   * Returns a Map keyed by `${subject} ${predicate} ${value}` so
   * callers can do O(1) lookups against returned hits.
   */
  corroborationCounts(
    tenantId: string,
    triples: ReadonlyArray<{
      readonly subject: string;
      readonly predicate: string;
      readonly value: string;
    }>,
  ): Promise<Map<string, number>>;

  /**
   * Aggregate current (non-superseded, non-retired) facts by subject.
   * Covered by idx_facts_subject_current.
   */
  listSubjectStats(tenantId: string): Promise<ReadonlyArray<SubjectStat>>;
}

/** Key encoding for corroborationCounts result map. */
export function corroborationKey(subject: string, predicate: string, value: string): string {
  return `${subject} ${predicate} ${value}`;
}
