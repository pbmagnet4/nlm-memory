/**
 * SignalStore -- the only way core/ reads or writes the signal corpus.
 *
 * Sibling to FactStore but deliberately simpler: append-only, idempotent on a
 * deterministic id (ON CONFLICT DO NOTHING), no supersedence, no embeddings.
 * Signals are high-volume structured telemetry, not LLM-distilled facts.
 */

import type { Signal, SignalKind } from "@shared/types.js";

export interface SignalAggregationFilter {
  readonly installScope: string;
  readonly repo?: string;
  readonly model?: string;
  readonly kind?: SignalKind;
  /** ISO lower bound on `ts` (inclusive). Omit for all-time. */
  readonly sinceTs?: string;
  /** Safety cap on rows scanned. Defaults to 5000 in the adapter. */
  readonly limit?: number;
}

export interface SignalStore {
  /** Insert one signal. Idempotent: a duplicate id is a no-op, not an error. */
  insert(tenantId: string, signal: Signal): Promise<void>;

  /** Insert many signals in one transaction. Duplicate ids are skipped. */
  insertMany(tenantId: string, signals: ReadonlyArray<Signal>): Promise<void>;

  /**
   * Rows matching the filter, newest `ts` first, for in-process aggregation.
   * Tenant is the outer mandatory filter; installScope stays the within-
   * tenant discriminator (program spec §4.6 hardening 3).
   */
  listForAggregation(tenantId: string, filter: SignalAggregationFilter): Promise<ReadonlyArray<Signal>>;

  /** Count signals for an install with `ts >= sinceTs`, within tenantId. */
  countSince(tenantId: string, installScope: string, sinceTs: string): Promise<number>;

  /** Delete signals with `ts < olderThanTs`, within tenantId. Returns rows deleted. */
  pruneOlderThan(tenantId: string, olderThanTs: string): Promise<number>;
}
