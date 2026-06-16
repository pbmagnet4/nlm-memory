/**
 * CodeExemplarStore — the only way core/ reads or writes the code-exemplar
 * corpus.
 *
 * Sibling to SignalStore: append-only, idempotent on a deterministic id
 * (same code_hash in the same scope is a no-op), no supersedence. The
 * vec lane is optional — inserts succeed without an embedding; search
 * requires one.
 */

import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput } from "@shared/types.js";

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
  insert(input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }>;

  /** Insert many in one transaction. Duplicates are skipped. */
  insertMany(inputs: ReadonlyArray<CodeExemplarInput>): Promise<number>;

  /** Insert or update the embedding for an exemplar_id. */
  upsertEmbedding(exemplarId: string, vector: Float32Array): Promise<void>;

  /** Vector search + rerank. Returns up to k results nearest the query vector. */
  searchByVector(queryVector: Float32Array, filter: CodeExemplarSearchFilter): Promise<ReadonlyArray<CodeExemplarHit>>;

  /** Fetch exemplar by id. */
  getById(id: string): Promise<CodeExemplar | null>;

  /**
   * Per-bucket cap enforcement: delete oldest rows beyond maxPerBucket,
   * bucketed by (install_scope, repo, lang, outcome_class).
   * outcome_class = 'positive' for pass/fix, 'negative' for fail/exhausted.
   * Returns total rows deleted.
   */
  applyBucketCap(installScope: string, maxPerBucket: number): Promise<number>;

  /** Delete exemplars with survived=0 (reverted code). Returns rows deleted. */
  pruneReverted(installScope: string): Promise<number>;

  /** Delete exemplars with ts < olderThanTs (optional clock-based escape hatch). */
  pruneOlderThan(olderThanTs: string): Promise<number>;
}
