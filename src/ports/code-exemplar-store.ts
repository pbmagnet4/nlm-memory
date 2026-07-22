/**
 * CodeExemplarStore — the only way core/ reads or writes the code-exemplar
 * corpus.
 *
 * Sibling to SignalStore: append-only, idempotent on a deterministic id
 * (same code_hash in the same scope is a no-op), no supersedence. The
 * vec lane is optional — inserts succeed without an embedding; search
 * requires one.
 */

import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";

export type ExemplarVerdictSource = "llm" | "human";

export interface ExemplarVerdictPatch {
  readonly retired?: boolean;
  readonly outcome?: CodeExemplarOutcome;
}

export interface ExemplarVerdictResult {
  readonly status: "applied" | "not_found" | "human_locked";
}

export interface CodeExemplarSearchFilter {
  readonly installScope: string;
  readonly repo?: string;
  readonly lang?: string;
  readonly model?: string;
  readonly includeNegatives?: boolean;
  /** Number of results to return. Default 5. */
  readonly k?: number;
}

export interface CodeExemplarStore {
  /** Insert one exemplar. Duplicate code_hash in the same install_scope is a no-op. */
  insert(tenantId: string, input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }>;

  /** Insert many in one transaction. Duplicates are skipped. */
  insertMany(tenantId: string, inputs: ReadonlyArray<CodeExemplarInput>): Promise<number>;

  /** Insert or update the embedding for an exemplar_id. No-op if the exemplar isn't owned by tenantId. */
  upsertEmbedding(tenantId: string, exemplarId: string, vector: Float32Array): Promise<void>;

  /** Vector search + rerank. Returns up to k results nearest the query vector, tenant-filtered inside the vec/embedding id-resolution SQL. */
  searchByVector(tenantId: string, queryVector: Float32Array, filter: CodeExemplarSearchFilter): Promise<ReadonlyArray<CodeExemplarHit>>;

  /** Fetch exemplar by id. Cross-tenant id returns null (same shape as missing). */
  getById(tenantId: string, id: string): Promise<CodeExemplar | null>;

  /**
   * List non-retired exemplars across all given sessions. Empty input
   * returns [] immediately.
   */
  listBySessions(tenantId: string, sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>>;

  /**
   * Per-bucket cap enforcement: delete oldest rows beyond maxPerBucket,
   * bucketed by (install_scope, repo, lang, outcome_class).
   * outcome_class = 'positive' for pass/fix, 'negative' for fail/exhausted.
   * Returns total rows deleted.
   */
  applyBucketCap(tenantId: string, installScope: string, maxPerBucket: number): Promise<number>;

  /** Delete exemplars with survived=0 (reverted code). Returns rows deleted. */
  pruneReverted(tenantId: string, installScope: string): Promise<number>;

  /** Delete exemplars with ts < olderThanTs (optional clock-based escape hatch). */
  pruneOlderThan(tenantId: string, olderThanTs: string): Promise<number>;

  /**
   * Apply an operator/LLM verdict (retire/un-retire and/or relabel outcome).
   * Human-wins: a `source: "llm"` call is a no-op when the row is already
   * `label_source: "human"`. Returns the outcome so callers can surface it.
   */
  setVerdict(tenantId: string, id: string, patch: ExemplarVerdictPatch, source: ExemplarVerdictSource): Promise<ExemplarVerdictResult>;
}
