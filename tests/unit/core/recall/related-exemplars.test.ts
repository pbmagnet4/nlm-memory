import { describe, expect, it } from "vitest";
import { pickRelatedExemplars } from "../../../../src/core/recall/related-exemplars.js";
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
  };
}
const embedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };
const throwingEmbedder: CodeEmbedder = { async embed() { throw new Error("ollama down"); } };

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
});
