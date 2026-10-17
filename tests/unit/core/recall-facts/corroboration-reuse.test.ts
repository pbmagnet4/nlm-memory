import { expect, it, vi } from "vitest";
import { FactRecallService } from "../../../../src/core/recall-facts/fact-recall-service.js";
import type { FactStore } from "../../../../src/ports/fact-store.js";
import { StubEmbedder } from "../../../fixtures/llm-stubs.js";
import { makeFact } from "../../../fixtures/facts.js";

function fixture() {
  const lexical = makeFact({ id: "lexical", value: "alpha", subject: "project", predicate: "database" });
  const semantic = makeFact({ id: "semantic", value: "changed alpha", subject: "project", predicate: "database" });
  const counts = vi.fn(async (_tenant: string, triples: readonly { subject: string; predicate: string; value: string }[]) =>
    new Map(triples.map((t) => [`${t.subject} ${t.predicate} ${t.value}`, t.value === "alpha" ? 0 : 3])));
  const store = { listForRecall: vi.fn(async () => [lexical]),
    semanticSearch: vi.fn(async () => [{ factId: "lexical", distance: 0 }, { factId: "semantic", distance: 0.1 }]),
    getByIds: vi.fn(async () => [semantic]), corroborationCounts: counts } as unknown as FactStore;
  return { counts, service: new FactRecallService({ factStore: store, llm: new StubEmbedder() }) };
}
it("reads each identical tenant/triple once across lexical progress and final merge, retaining zero counts", async () => {
  const { service, counts } = fixture();
  const progress = vi.fn(async () => undefined);
  const result = await service.search("tenant-a", { query: "alpha", mode: "hybrid" }, { onPartialFacts: progress });
  expect(progress).toHaveBeenCalledOnce();
  expect(counts.mock.calls.map(([tenant, triples]) => ({ tenant, values: triples.map((t) => t.value) }))).toEqual([
    { tenant: "tenant-a", values: ["alpha"] }, { tenant: "tenant-a", values: ["changed alpha"] },
  ]);
  expect(result.results.find((f) => f.id === "lexical")?.corroborationCount).toBe(0);
  expect(result.results.find((f) => f.id === "semantic")?.corroborationCount).toBe(3);
});
it("never reuses counts across requests or authenticated tenants", async () => {
  const { service, counts } = fixture();
  for (const tenant of ["tenant-a", "tenant-a", "tenant-b"]) {
    await service.search(tenant, { query: "alpha", mode: "hybrid" }, { onPartialFacts: async () => undefined });
  }
  expect(counts.mock.calls.map(([tenant, triples]) => [tenant, triples.map((t) => t.value)])).toEqual([
    ["tenant-a", ["alpha"]], ["tenant-a", ["changed alpha"]],
    ["tenant-a", ["alpha"]], ["tenant-a", ["changed alpha"]],
    ["tenant-b", ["alpha"]], ["tenant-b", ["changed alpha"]],
  ]);
});
it("lexical fact progress preserves final hybrid fallback scoring", async () => {
  const { service } = fixture();
  const embed = vi.spyOn(service.embeddingClient, "embed").mockRejectedValue(new (await import("../../../../src/ports/llm-client.js")).LLMUnreachableError("outage"));
  let progress: unknown;
  const result = await service.search("tenant-a", { query: "alpha", mode: "hybrid" }, {
    onPartialFacts: async (partial) => { progress = partial.results; },
  });
  expect(progress).toEqual(result.results);
  embed.mockRestore();
});
