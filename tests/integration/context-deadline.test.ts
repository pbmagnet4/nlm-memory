import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { recallContext, type ContextDeps } from "../../src/core/context/recall-context.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { embedForRecall, RequestBudget } from "../../src/core/recall/request-budget.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import type { SessionStore } from "../../src/ports/session-store.js";
import type { FactStore } from "../../src/ports/fact-store.js";

function fixture(llm = new StubEmbedder()) {
  const session = makeSession({ id: "source", label: "alpha", summary: "alpha" });
  const fact = makeFact({ id: "fact", value: "alpha", sourceSessionId: "source" });
  const store = { keywordSearch: vi.fn(async () => [{ sessionId: "source", score: 1 }]),
    semanticSearch: vi.fn(async () => []), getByIds: vi.fn(async () => [session]), getById: vi.fn(async () => session), resolveSuccessors: vi.fn(async () => new Map()) } as unknown as SessionStore;
  const factStore = { listForRecall: vi.fn(async () => [fact]), semanticSearch: vi.fn(async () => []),
    corroborationCounts: vi.fn(async () => new Map()), summarizeCurrentValues: vi.fn(async () => ({ distinctValueCount: 1, sourceSessionCount: 1, examples: [] })) } as unknown as FactStore;
  const deps: ContextDeps = { store, factStore, recall: new RecallService({ store, llm }), factRecall: new FactRecallService({ factStore, llm }), now: () => Date.now() };
  return { deps, llm };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.restoreAllMocks(); vi.useRealTimers(); });
it("hybrid-both shares one exact embedding per request, never across requests", async () => {
  const { deps, llm } = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await recallContext("tenant-a", { query: "alpha", mode: "hybrid" }, deps);
    expect(result.coverage).toMatchObject({ facts: "complete", sessions: "complete" });
    expect(llm.calls).toBe(i + 1);
  }
});
it("different client identities and different exact text do not share", async () => {
  const { deps, llm } = fixture();
  const other = new StubEmbedder();
  await recallContext("tenant-a", { query: "alpha", mode: "hybrid" }, { ...deps, factRecall: new FactRecallService({ factStore: deps.factStore!, llm: other }) });
  expect(llm.calls).toBe(1); expect(other.calls).toBe(1);
  await recallContext("tenant-a", { query: " alpha ", mode: "hybrid" }, deps);
  expect(llm.calls).toBe(3);
});
it("ignores a supplied promise unless text, kind, and client identity all match", async () => {
  const llm = new StubEmbedder();
  const promise = Promise.resolve({ vector: new Float32Array(768), model: "wrong" });
  for (const identity of [
    { text: "other", kind: "query" as const, client: llm },
    { text: "alpha", kind: "document" as const, client: llm },
    { text: "alpha", kind: "query" as const, client: new StubEmbedder() },
  ]) await embedForRecall(llm, "alpha", { queryEmbedding: promise, queryEmbeddingIdentity: identity, now: () => Date.now() }, 100);
  expect(llm.calls).toBe(3);
});
it("hanging embedding observes abort, preserves lexical evidence and removes listeners", async () => {
  const llm = new StubEmbedder({ hang: true });
  const { deps } = fixture(llm);
  const abort = new AbortController();
  const pending = recallContext("tenant-a", { query: "alpha", mode: "hybrid", timeoutMs: 100, signal: abort.signal }, deps);
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;
  expect(result.facts.map((f) => f.id)).toEqual(["fact"]);
  expect(result.sessions.map((s) => s.id)).toEqual(["source"]);
  expect(result.coverage).toMatchObject({ facts: "partial", sessions: "partial" });
  expect(llm.calls).toBe(1);
  expect(llm.aborts).toBe(1);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});
it("safe exact lookup and already aborted request make zero embedding calls", async () => {
  const { deps, llm } = fixture();
  const sessionSearch = vi.spyOn(deps.recall, "search");
  await recallContext("tenant-a", { query: "alpha", subject: "s", predicate: "p", intent: "lookup", mode: "hybrid" }, deps);
  await recallContext("tenant-a", { query: "alpha", mode: "hybrid", signal: AbortSignal.abort() }, deps);
  expect(llm.calls).toBe(0); expect(sessionSearch).not.toHaveBeenCalled();
});
it("composes a tighter parent deadline instead of adding another full embedding cap", async () => {
  const llm = new StubEmbedder({ hang: true });
  const pending = embedForRecall(llm, "alpha", { deadlineAt: Date.now() + 30, now: () => Date.now() }, 2000).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(30);
  expect(await pending).toBeInstanceOf(Error);
  expect(llm.aborts).toBe(1);
});
it("a successful budget operation removes its abort listener and dispose removes the parent listener", async () => {
  const parent = new AbortController();
  const budget = new RequestBudget(100, { signal: parent.signal, now: () => Date.now() });
  await budget.run(async () => 1);
  expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
  budget.dispose();
  expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
});

it("semantic-both shares its exact embedding and observes the tighter session cap", async () => {
  const { deps, llm } = fixture(new StubEmbedder({ hang: true }));
  vi.spyOn(deps.recall, "embeddingTimeoutMs", "get").mockReturnValue(30);
  const pending = recallContext("tenant-a", { query: "alpha", mode: "semantic", timeoutMs: 100 }, deps);
  await vi.advanceTimersByTimeAsync(30);
  const result = await pending;
  expect(llm.calls).toBe(1); expect(llm.aborts).toBe(1);
  expect(result.coverage).toMatchObject({ facts: "unavailable", sessions: "unavailable" });
});
it("MCP validates timeout range at the boundary", async () => {
  const { recallContextHandler } = await import("../../src/mcp/server.js");
  const { deps, llm } = fixture();
  for (const timeoutMs of [99, 5001]) {
    const result = await recallContextHandler({ store: deps.store, recall: deps.recall }, "tenant-a", { query: "alpha", timeoutMs });
    expect(result.isError).toBe(true);
  }
  expect(llm.calls).toBe(0);
});
it("registered MCP context tool propagates transport cancellation before outbound work", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { createMcpServer } = await import("../../src/mcp/server.js");
  const registered = vi.spyOn(McpServer.prototype, "registerTool");
  const { deps, llm } = fixture();
  const search = vi.spyOn(deps.recall, "search");
  const server = createMcpServer({ store: deps.store, recall: deps.recall }, "tenant-a");
  const callback = registered.mock.calls.find((args) => args[0] === "recall_context")![2] as unknown as
    (args: object, extra: { signal: AbortSignal }) => Promise<unknown>;
  await callback({ query: "alpha", mode: "hybrid" }, { signal: AbortSignal.abort() });
  expect(search).not.toHaveBeenCalled(); expect(llm.calls).toBe(0);
  await server.close();
});
