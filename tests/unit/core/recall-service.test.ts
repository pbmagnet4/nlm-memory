import { describe, expect, it } from "vitest";
import { RecallService } from "../../../src/core/recall/recall-service.js";
import type { LLMClient, EmbedResult } from "../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";
import type {
  SessionStore,
  SemanticNeighbor,
} from "../../../src/ports/session-store.js";
import type { Session } from "../../../src/shared/types.js";
import { makeSession } from "../../fixtures/sessions.js";

class InMemoryStore implements SessionStore {
  constructor(
    private readonly sessions: Session[],
    private readonly neighbors: SemanticNeighbor[] = [],
  ) {}
  async list(): Promise<ReadonlyArray<Session>> {
    return this.sessions;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return this.neighbors;
  }
  async updateStatus(): Promise<void> {}
}

class StubEmbedder implements LLMClient {
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    if (this.fail) throw new LLMUnreachableError("ollama");
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const corpus: Session[] = [
  makeSession({
    id: "a",
    label: "Hono router setup",
    entities: ["NLE Memory"],
    decisions: ["chose Hono over Express"],
  }),
  makeSession({
    id: "b",
    label: "pgvector migration plan",
    entities: ["NLE Memory", "Postgres"],
    open: ["timing of cutover"],
  }),
  makeSession({
    id: "c",
    label: "unrelated session",
    entities: ["Other"],
  }),
];

describe("RecallService.search", () => {
  it("returns empty result when query and filters are all blank", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "" });
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("keyword mode ranks higher-weighted field matches first", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("b");
    expect(result.results[0]?.matchScore).toBe(3); // label weight
  });

  it("entity filter restricts the search corpus", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({
      query: "session",
      mode: "keyword",
      entity: "NLE Memory",
    });
    expect(result.results.every((r) => r.entities.includes("NLE Memory"))).toBe(true);
  });

  it("semantic mode returns ollama_unreachable when the embedder fails", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toEqual([]);
  });

  it("hybrid mode degrades to keyword scores when semantic is unavailable", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("b");
  });

  it("semantic mode reports cosine similarity computed from L2 distance of unit vectors", async () => {
    const store = new InMemoryStore(corpus, [{ sessionId: "a", distance: 0 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    // distance 0 => perfect match => cos sim 1.0
    expect(result.results[0]?.matchScore).toBe(1);
  });

  it("hybrid mode blends 0.4 * kw + 0.6 * sem after per-field normalization", async () => {
    const store = new InMemoryStore(corpus, [{ sessionId: "b", distance: 0 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    const top = result.results[0];
    expect(top?.id).toBe("b");
    // kwNorm = 1 (only hit), semNorm = 1 (distance 0) => 0.4 + 0.6 = 1
    expect(top?.matchScore).toBeCloseTo(1, 4);
    expect(top?.keywordScore).toBe(1);
    expect(top?.semanticScore).toBe(1);
  });

  it("clamps limit to MAX_LIMIT (100) and at least 1", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const big = await svc.search({ query: "session", mode: "keyword", limit: 9999 });
    expect(big.limit).toBe(100);
    const small = await svc.search({ query: "session", mode: "keyword", limit: 0 });
    expect(small.limit).toBe(1);
  });
});
