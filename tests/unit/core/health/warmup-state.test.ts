import { beforeEach, describe, expect, it } from "vitest";
import { markWarm, markWarmFailure, warmupSnapshot, resetWarmupState } from "../../../../src/core/health/warmup-state.js";

describe("warmup state", () => {
  beforeEach(() => resetWarmupState());

  it("starts cold and not ready", () => {
    expect(warmupSnapshot()).toEqual({ fts5: false, textEmbedder: false, ready: false });
  });

  it("is ready only after both stages warm", () => {
    markWarm("fts5");
    expect(warmupSnapshot().ready).toBe(false);
    markWarm("textEmbedder");
    expect(warmupSnapshot()).toEqual({ fts5: true, textEmbedder: true, ready: true });
  });

  it("single stage warm does not set ready", () => {
    markWarm("textEmbedder");
    expect(warmupSnapshot().fts5).toBe(false);
    expect(warmupSnapshot().ready).toBe(false);
  });
});

describe("warmup failure reporting", () => {
  beforeEach(() => resetWarmupState());

  it("omits lastError entirely while nothing has failed", () => {
    expect(warmupSnapshot()).toEqual({ fts5: false, textEmbedder: false, ready: false });
  });

  it("names the cause instead of leaving a bare false", () => {
    markWarmFailure("textEmbedder", "connect ECONNREFUSED 127.0.0.1:1234", 1);
    const snap = warmupSnapshot();
    expect(snap.textEmbedder).toBe(false);
    expect(snap.lastError?.textEmbedder).toMatchObject({
      reason: "connect ECONNREFUSED 127.0.0.1:1234",
      attempts: 1,
    });
  });

  it("keeps the first-failure timestamp while attempts climb, so health can show how long it has been down", () => {
    markWarmFailure("textEmbedder", "down", 1);
    const first = warmupSnapshot().lastError?.textEmbedder?.since;
    markWarmFailure("textEmbedder", "still down", 2);
    const later = warmupSnapshot().lastError?.textEmbedder;
    expect(later?.since).toBe(first);
    expect(later?.attempts).toBe(2);
    expect(later?.reason).toBe("still down");
  });

  it("clears the error once the stage warms, so a recovered lane reads clean", () => {
    markWarmFailure("textEmbedder", "down", 1);
    markWarm("textEmbedder");
    const snap = warmupSnapshot();
    expect(snap.textEmbedder).toBe(true);
    expect(snap.lastError).toBeUndefined();
  });
});
