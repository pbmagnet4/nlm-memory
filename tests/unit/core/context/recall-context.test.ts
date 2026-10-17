import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallContext, type ContextDeps } from "../../../../src/core/context/recall-context.js";

const delay = <T>(value: T, ms = 100) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
function fixture() {
  const facts = { query: "alpha", mode: "keyword", results: [], total: 0 };
  const sessions = { query: "alpha", mode: "keyword", results: [], total: 0 };
  const deps = {
    recall: { search: vi.fn(() => delay(sessions)) },
    factRecall: { search: vi.fn(() => delay(facts)) },
    store: { getByIds: vi.fn(async () => []), getById: vi.fn(async () => null), resolveSuccessors: vi.fn(async () => new Map()) },
    factStore: { summarizeCurrentValues: vi.fn(async () => ({ distinctValueCount: 1, sourceSessionCount: 1, examples: [] })), listBySessions: vi.fn(async () => []) },
    now: () => Date.now(),
  };
  return { deps, run: (input = {}) => recallContext("tenant-a", { query: "alpha", mode: "keyword", ...input }, deps as unknown as ContextDeps) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
describe("one recall request budget", () => {
  it("overlaps two independent 100ms lanes", async () => {
    const { run, deps } = fixture();
    const pending = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.recall.search).toHaveBeenCalledOnce();
    expect(deps.factRecall.search).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.coverage).toMatchObject({ facts: "complete", sessions: "complete" });
  });
  it("complete unique lookup skips session search", async () => {
    const { run, deps } = fixture();
    const pending = run({ subject: "alpha", predicate: "uses", intent: "lookup" });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.lookup).toMatchObject({ complete: true, distinctValueCount: 1 });
    expect(deps.recall.search).not.toHaveBeenCalled();
  });
  it("one failed lane retains the other", async () => {
    const { run, deps } = fixture();
    deps.factRecall.search.mockRejectedValue(new Error("unavailable"));
    const pending = run();
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).coverage).toMatchObject({ facts: "unavailable", sessions: "complete" });
  });
  it("already aborted launches no lane or source read", async () => {
    const { run, deps } = fixture();
    await run({ signal: AbortSignal.abort() });
    expect(deps.recall.search).not.toHaveBeenCalled();
    expect(deps.factRecall.search).not.toHaveBeenCalled();
    expect(deps.store.getByIds).not.toHaveBeenCalled();
  });
  it("deadline detaches a late completion and cleans timers", async () => {
    const { run, deps } = fixture();
    let complete!: (value: unknown) => void;
    deps.factRecall.search.mockImplementation(() => new Promise((r) => { complete = r; }) as never);
    const pending = run({ timeoutMs: 150 });
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;
    const frozen = JSON.stringify(result);
    expect(result.coverage).toMatchObject({ facts: "unavailable", sessions: "complete" });
    complete({ results: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(result)).toBe(frozen);
  });
});
