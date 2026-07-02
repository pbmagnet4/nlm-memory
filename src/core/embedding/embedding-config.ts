export type EmbeddingLane = "prose" | "code";

export interface EmbeddingLaneConfig {
  readonly lane: EmbeddingLane;
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
}

export interface EmbeddingConfigStore {
  getLane(lane: EmbeddingLane): EmbeddingLaneConfig | null;
  upsertLane(cfg: EmbeddingLaneConfig, updatedAtIso: string): void;
}

export type LaneReconcileState = "recorded" | "match" | "stale";

export interface LaneReconcileResult {
  readonly state: LaneReconcileState;
  readonly stored: EmbeddingLaneConfig | null;
}

export function reconcileLane(
  store: EmbeddingConfigStore,
  runtime: EmbeddingLaneConfig,
  nowIso: string,
): LaneReconcileResult {
  const stored = store.getLane(runtime.lane);
  if (!stored) {
    store.upsertLane(runtime, nowIso);
    return { state: "recorded", stored: null };
  }
  const match =
    stored.provider === runtime.provider &&
    stored.model === runtime.model &&
    stored.dim === runtime.dim;
  return { state: match ? "match" : "stale", stored };
}
