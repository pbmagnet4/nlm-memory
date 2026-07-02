import { beforeEach, describe, expect, it } from "vitest";
import { markWarm, warmupSnapshot, resetWarmupState } from "../../../../src/core/health/warmup-state.js";

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
