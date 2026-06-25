/**
 * FactRecallService unit tests against an in-memory FactStore + fake LLM.
 * Mirrors the recall-service.test.ts pattern.
 */

import { describe, expect, it } from "vitest";
import { FactRecallService } from "../../../../src/core/recall-facts/fact-recall-service.js";
import type {
  FactListFilter,
  FactSemanticNeighbor,
  FactStore,
} from "../../../../src/ports/fact-store.js";
import type { EmbedResult, LLMClient } from "../../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../../src/ports/llm-client.js";
import type { Fact, FactHistoryChain } from "../../../../src/shared/types.js";
import { makeFact } from "../../../fixtures/facts.js";

class InMemoryFactStore implements FactStore {
  constructor(
    private readonly facts: Fact[],
    private readonly neighbors: FactSemanticNeighbor[] = [],
  ) {}
  async insert(): Promise<void> {}
  async insertMany(): Promise<void> {}
  async getById(id: string): Promise<Fact | null> {
    return this.facts.find((f) => f.id === id) ?? null;
  }
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>> {
    const set = new Set(ids);
    return this.facts.filter((f) => set.has(f.id));
  }
  async findCurrent(subject: string, predicate: string): Promise<Fact | null> {
    return this.facts.find(
      (f) =>
        f.subject === subject &&
        f.predicate === predicate &&
        f.supersededBy === null,
    ) ?? null;
  }
  async list(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async listBySession(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async listBySessions(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async markSuperseded(): Promise<void> {}
  async retire(): Promise<void> {}
  async listForRecall(filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    return this.facts.filter((f) => {
      if (filter.subject !== undefined && f.subject !== filter.subject) return false;
      if (filter.predicate !== undefined && f.predicate !== filter.predicate) return false;
      if (filter.kind !== undefined && f.kind !== filter.kind) return false;
      if (filter.minConfidence !== undefined && f.confidence < filter.minConfidence) return false;
      if (filter.includeSuperseded !== true && f.supersededBy !== null) return false;
      return true;
    });
  }
  async semanticSearch(): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    return this.neighbors;
  }
  async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> {
    return [];
  }
  async corroborationCounts(
    triples: ReadonlyArray<{ subject: string; predicate: string; value: string }>,
  ): Promise<Map<string, number>> {
    // Default: every triple is corroborated by exactly one session (no boost
    // factor != 1.0). Subclass/spy if a test wants to inject specific counts.
    const m = new Map<string, number>();
    for (const t of triples) m.set(`${t.subject} ${t.predicate} ${t.value}`, 1);
    return m;
  }
  async upsertEmbedding(): Promise<void> {}
  async ingestSessionFacts(): Promise<void> {}
}

class StubEmbedder implements LLMClient {
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    if (this.fail) throw new LLMUnreachableError("ollama");
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used in tests");
  }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const corpus: Fact[] = [
  makeFact({
    id: "f_hono",
    kind: "decision",
    subject: "nlm-memory-ts",
    predicate: "framework",
    value: "Hono",
    confidence: 0.9,
  }),
  makeFact({
    id: "f_endpoint",
    kind: "attribute",
    subject: "mac-pro-llm-host",
    predicate: "endpoint",
    value: "http://macpro:8080/v1",
    confidence: 0.85,
  }),
  makeFact({
    id: "f_model",
    kind: "attribute",
    subject: "mac-pro-llm-host",
    predicate: "model",
    value: "qwen2.5-3b",
    confidence: 0.8,
  }),
  makeFact({
    id: "f_lowconf",
    kind: "decision",
    subject: "other",
    predicate: "framework",
    value: "Hono",
    confidence: 0.5,
  }),
  makeFact({
    id: "f_superseded",
    kind: "decision",
    subject: "nlm-memory-ts",
    predicate: "framework",
    value: "Fastify",
    confidence: 0.9,
    supersededBy: "f_hono",
  }),
];

describe("FactRecallService.search (keyword)", () => {
  it("returns empty when no query and no structured filter", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({});
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("exact subject + predicate returns current fact (no query text)", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({
      subject: "nlm-memory-ts",
      predicate: "framework",
    });
    expect(result.total).toBe(1);
    expect(result.results[0]?.id).toBe("f_hono");
    expect(result.results[0]?.value).toBe("Hono");
  });

  it("excludes superseded facts by default", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ subject: "nlm-memory-ts" });
    expect(result.results.map((r) => r.id)).toEqual(["f_hono"]);
  });

  it("includeSuperseded=true returns the full chain", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({
      subject: "nlm-memory-ts",
      includeSuperseded: true,
    });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_hono", "f_superseded"]);
  });

  it("default minConfidence (0.6) drops low-confidence facts", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ predicate: "framework" });
    // f_lowconf has confidence 0.5; f_hono has 0.9; f_superseded is dropped
    expect(result.results.map((r) => r.id)).toEqual(["f_hono"]);
  });

  it("explicit minConfidence override widens the result set", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ predicate: "framework", minConfidence: 0.4 });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_hono", "f_lowconf"]);
  });

  it("free-text query scores against value, subject, predicate", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "Hono" });
    expect(result.results[0]?.id).toBe("f_hono");
    expect(result.results[0]?.matchedIn).toContain("value");
  });

  it("kind filter narrows to attribute / decision / open", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ kind: "attribute" });
    expect(result.results.map((r) => r.id).sort()).toEqual(["f_endpoint", "f_model"]);
  });

  it("limit caps the result count", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ kind: "attribute", limit: 1 });
    expect(result.results).toHaveLength(1);
  });
});

describe("FactRecallService.search (semantic)", () => {
  it("uses sqlite-vec neighbors to rank candidates", async () => {
    const neighbors: FactSemanticNeighbor[] = [
      { factId: "f_endpoint", distance: 0.2 },
      { factId: "f_model", distance: 0.6 },
    ];
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus, neighbors),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "where does the LLM run", mode: "semantic" });
    expect(result.results[0]?.id).toBe("f_endpoint");
    expect(result.results[0]?.matchedIn).toEqual(["semantic"]);
  });

  it("LLM unreachable surfaces as modeUnavailable, not an exception", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.total).toBe(0);
  });

  it("returns a semantic neighbour that falls outside the keyword candidate window", async () => {
    // Simulates the real recency-capped listForRecall: the gold fact is NOT in
    // the keyword candidate window, but IS the top vector neighbour and is
    // resolvable via getByIds. Before the coverage fix it was silently dropped.
    const old = makeFact({
      id: "f_old_decision",
      kind: "decision",
      subject: "legacy-service",
      predicate: "datastore",
      value: "Postgres",
      confidence: 0.9,
    });
    const store = new InMemoryFactStore([...corpus, old], [{ factId: "f_old_decision", distance: 0.1 }]);
    // Force the window to exclude the old fact (only the original corpus is "recent").
    store.listForRecall = async () => corpus;
    const svc = new FactRecallService({ factStore: store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "legacy datastore choice", mode: "semantic" });
    expect(result.results.map((r) => r.id)).toContain("f_old_decision");
  });

  it("excludes a semantic neighbour that fails the confidence floor when fetched outside the window", async () => {
    const lowConf = makeFact({
      id: "f_old_lowconf",
      kind: "decision",
      subject: "legacy-service",
      predicate: "cache",
      value: "Redis",
      confidence: 0.4,
    });
    const store = new InMemoryFactStore([...corpus, lowConf], [{ factId: "f_old_lowconf", distance: 0.1 }]);
    store.listForRecall = async () => corpus;
    const svc = new FactRecallService({ factStore: store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "legacy cache choice", mode: "semantic" });
    expect(result.results.map((r) => r.id)).not.toContain("f_old_lowconf");
  });
});

describe("FactRecallService.search (hybrid)", () => {
  it("ranks semantic hits above keyword-only backfill and exposes both subscores", async () => {
    // f_endpoint is a strong semantic neighbour but does NOT keyword-match
    // "Hono"; f_hono keyword-matches but is a weak semantic neighbour. Under
    // semantic-primary merge, the semantic hits occupy the upper band and the
    // keyword-only hit backfills below them.
    const neighbors: FactSemanticNeighbor[] = [{ factId: "f_endpoint", distance: 0.1 }];
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus, neighbors),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "Hono", mode: "hybrid" });
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("f_endpoint"); // semantic
    expect(ids).toContain("f_hono"); // keyword-only backfill
    // Semantic hit ranks above the keyword-only backfill.
    expect(ids.indexOf("f_endpoint")).toBeLessThan(ids.indexOf("f_hono"));
    const semHit = result.results.find((r) => r.id === "f_endpoint")!;
    const kwHit = result.results.find((r) => r.id === "f_hono")!;
    expect(semHit.matchScore).toBeGreaterThan(0.5); // strong semantic neighbour
    expect(kwHit.matchScore).toBeLessThanOrEqual(0.5); // backfill band ceiling
    expect(kwHit.semanticScore).toBe(0);
    for (const hit of result.results) {
      expect(hit.keywordScore).toBeDefined();
      expect(hit.semanticScore).toBeDefined();
    }
  });

  it("degrades to keyword-only when the embedder is unreachable", async () => {
    const svc = new FactRecallService({
      factStore: new InMemoryFactStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "Hono", mode: "hybrid" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    // Keyword leg still returns the match — recall is not empty.
    expect(result.results.map((r) => r.id)).toContain("f_hono");
  });
});
