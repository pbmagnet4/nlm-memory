import { describe, expect, it } from "vitest";
import {
  reconcileLane,
  type EmbeddingConfigStore,
  type EmbeddingLane,
  type EmbeddingLaneConfig,
} from "../../../../src/core/embedding/embedding-config.js";

function makeCfg(overrides: Partial<EmbeddingLaneConfig> = {}): EmbeddingLaneConfig {
  return {
    lane: "prose",
    provider: "ollama",
    model: "nomic-embed-text",
    dim: 768,
    ...overrides,
  };
}

function makeStore(initial: EmbeddingLaneConfig | null = null): EmbeddingConfigStore & {
  upsertCount: number;
} {
  let stored: EmbeddingLaneConfig | null = initial;
  return {
    upsertCount: 0,
    getLane(_lane: EmbeddingLane) {
      return stored;
    },
    upsertLane(cfg: EmbeddingLaneConfig, _updatedAtIso: string) {
      this.upsertCount++;
      stored = cfg;
    },
  };
}

describe("reconcileLane", () => {
  it("records the running config and returns 'recorded' when no row exists", () => {
    const store = makeStore(null);
    const runtime = makeCfg();
    const result = reconcileLane(store, runtime, "2026-07-01T00:00:00Z");
    expect(result.state).toBe("recorded");
    expect(result.stored).toBeNull();
    expect(store.upsertCount).toBe(1);
  });

  it("returns 'match' and does not write when stored config is identical", () => {
    const cfg = makeCfg();
    const store = makeStore(cfg);
    const result = reconcileLane(store, makeCfg(), "2026-07-01T00:00:00Z");
    expect(result.state).toBe("match");
    expect(result.stored).toEqual(cfg);
    expect(store.upsertCount).toBe(0);
  });

  it("returns 'stale' with the stored row when provider differs", () => {
    const stored = makeCfg({ provider: "openai" });
    const store = makeStore(stored);
    const result = reconcileLane(store, makeCfg({ provider: "ollama" }), "2026-07-01T00:00:00Z");
    expect(result.state).toBe("stale");
    expect(result.stored).toEqual(stored);
  });

  it("returns 'stale' with the stored row when model differs", () => {
    const stored = makeCfg({ model: "old-model" });
    const store = makeStore(stored);
    const result = reconcileLane(store, makeCfg({ model: "new-model" }), "2026-07-01T00:00:00Z");
    expect(result.state).toBe("stale");
    expect(result.stored).toEqual(stored);
  });

  it("returns 'stale' with the stored row when dim differs", () => {
    const stored = makeCfg({ dim: 384 });
    const store = makeStore(stored);
    const result = reconcileLane(store, makeCfg({ dim: 768 }), "2026-07-01T00:00:00Z");
    expect(result.state).toBe("stale");
    expect(result.stored).toEqual(stored);
  });

  it("does not overwrite the stored row on stale", () => {
    const stored = makeCfg({ provider: "openai" });
    const store = makeStore(stored);
    reconcileLane(store, makeCfg({ provider: "ollama" }), "2026-07-01T00:00:00Z");
    expect(store.upsertCount).toBe(0);
  });

  it("handles the 'code' lane", () => {
    const store = makeStore(null);
    const runtime = makeCfg({ lane: "code", model: "nomic-embed-code", dim: 256 });
    const result = reconcileLane(store, runtime, "2026-07-01T00:00:00Z");
    expect(result.state).toBe("recorded");
    expect(result.stored).toBeNull();
  });
});
