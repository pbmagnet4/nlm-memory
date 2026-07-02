import type { EmbeddingLane } from "@core/embedding/embedding-config.js";

export type EmbeddingLaneHealth = "unknown" | "ok" | "stale";

const state: Record<EmbeddingLane, EmbeddingLaneHealth> = {
  prose: "unknown",
  code: "unknown",
};

export function setLaneHealth(lane: EmbeddingLane, health: EmbeddingLaneHealth): void {
  state[lane] = health;
}

export function laneHealth(lane: EmbeddingLane): EmbeddingLaneHealth {
  return state[lane];
}

export function laneHealthSnapshot(): Readonly<Record<EmbeddingLane, EmbeddingLaneHealth>> {
  return Object.freeze({ ...state });
}

export function resetLaneHealthForTests(): void {
  state.prose = "unknown";
  state.code = "unknown";
}
