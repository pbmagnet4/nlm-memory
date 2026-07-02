import { afterEach, describe, expect, it } from "vitest";
import { pickRelatedExemplars } from "../../../../src/core/recall/related-exemplars.js";
import {
  resetLaneHealthForTests,
  setLaneHealth,
} from "../../../../src/core/health/embedding-lane-state.js";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../../../src/ports/code-embedder.js";
import type { CodeExemplarHit } from "../../../../src/shared/types.js";

function hit(over: Partial<CodeExemplarHit> & { id: string; distance: number }): CodeExemplarHit {
  return {
    code: "code", taskContext: "ctx", outcome: "pass", repo: "/r", model: "m",
    lang: "ts", survived: null, gitSha: null, ...over,
  };
}
function storeReturning(hits: CodeExemplarHit[]): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return hits; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
    async listBySessions() { return []; },
  };
}
const embedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };
const throwingEmbedder: CodeEmbedder = { async embed() { throw new Error("ollama down"); } };

describe("pickRelatedExemplars stale code lane", () => {
  afterEach(resetLaneHealthForTests);

  it("returns [] immediately when code lane is stale, without calling the embedder", async () => {
    setLaneHealth("code", "stale");
    let embedCalls = 0;
    const countingEmbedder: CodeEmbedder = {
      async embed() {
        embedCalls++;
        return { vector: new Float32Array(768), dim: 768 };
      },
    };
    const store = storeReturning([hit({ id: "a", distance: 0.1 })]);
    const out = await pickRelatedExemplars("q", store, countingEmbedder, "scope");
    expect(out).toEqual([]);
    expect(embedCalls).toBe(0);
  });
});

describe("pickRelatedExemplars", () => {
  it("embeds the query and maps hits to lean RelatedExemplars", async () => {
    const store = storeReturning([
      hit({ id: "a", distance: 0.2, taskContext: "throttle helper", outcome: "pass", lang: "ts", repo: "/r" }),
    ]);
    const out = await pickRelatedExemplars("debounce a handler", store, embedder, "scope");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "a", outcome: "pass", lang: "ts", repo: "/r", taskContext: "throttle helper", distance: 0.2 });
  });

  it("drops hits beyond maxDistance", async () => {
    const store = storeReturning([
      hit({ id: "near", distance: 0.3 }),
      hit({ id: "far", distance: 1.5 }),
    ]);
    const out = await pickRelatedExemplars("q", store, embedder, "scope", { maxDistance: 1.0 });
    expect(out.map((e) => e.id)).toEqual(["near"]);
  });

  it("returns [] (best-effort) when the embedder throws", async () => {
    const store = storeReturning([hit({ id: "a", distance: 0.1 })]);
    const out = await pickRelatedExemplars("q", store, throwingEmbedder, "scope");
    expect(out).toEqual([]);
  });

  it("caps at k and requests k from the store", async () => {
    let askedK: number | undefined;
    const store: CodeExemplarStore = {
      ...storeReturning([hit({ id: "a", distance: 0.1 }), hit({ id: "b", distance: 0.2 })]),
      async searchByVector(_v, filter) { askedK = filter.k; return [hit({ id: "a", distance: 0.1 }), hit({ id: "b", distance: 0.2 })]; },
    };
    const out = await pickRelatedExemplars("q", store, embedder, "scope", { k: 1 });
    expect(askedK).toBe(1);
    expect(out).toHaveLength(1);
  });

  it("threads signal to the embedder", async () => {
    let capturedSignal: AbortSignal | undefined;
    const capturingEmbedder: CodeEmbedder = {
      async embed(_text, _role, signal) {
        capturedSignal = signal;
        return { vector: new Float32Array(768), dim: 768 };
      },
    };
    const controller = new AbortController();
    await pickRelatedExemplars("q", storeReturning([]), capturingEmbedder, "scope", { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("returns [] when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortsOnSignal: CodeEmbedder = {
      async embed(_text, _role, signal) {
        if (signal?.aborted) throw new Error("aborted");
        return { vector: new Float32Array(768), dim: 768 };
      },
    };
    const out = await pickRelatedExemplars("q", storeReturning([hit({ id: "a", distance: 0.1 })]), abortsOnSignal, "scope", { signal: controller.signal });
    expect(out).toEqual([]);
  });
});
