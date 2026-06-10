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
  insert(signal: Signal): Promise<void>;

  /** Insert many signals in one transaction. Duplicate ids are skipped. */
  insertMany(signals: ReadonlyArray<Signal>): Promise<void>;

  /** Rows matching the filter, newest `ts` first, for in-process aggregation. */
  listForAggregation(filter: SignalAggregationFilter): Promise<ReadonlyArray<Signal>>;

  /** Count signals for an install with `ts >= sinceTs`. */
  countSince(installScope: string, sinceTs: string): Promise<number>;

  /** Delete signals with `ts < olderThanTs`. Returns rows deleted. */
  pruneOlderThan(olderThanTs: string): Promise<number>;
}
