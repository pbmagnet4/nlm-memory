import { describe, expect, it } from "vitest";
import { embedForRecall } from "../../../../src/core/recall/request-budget.js";
import { createCircuitBreaker, FAILURE_THRESHOLD } from "../../../../src/core/health/embed-breaker.js";
import { LLMUnreachableError, type LLMClient } from "../../../../src/ports/llm-client.js";

const vector = { vector: new Float32Array(768), dim: 768 };
function client(embed: LLMClient["embed"]): LLMClient & { calls: number } {
  const c = { calls: 0, embed: (...a: Parameters<LLMClient["embed"]>) => { c.calls += 1; return embed(...a); } };
  return c as unknown as LLMClient & { calls: number };
}

describe("embedForRecall circuit breaker", () => {
  it("stops calling a failing embedder and fails fast with LLMUnreachableError", async () => {
    const breaker = createCircuitBreaker();
    const down = client(async () => { throw new Error("ECONNREFUSED"); });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(embedForRecall(down, "q", {}, 1000, breaker)).rejects.toBeInstanceOf(LLMUnreachableError);
    }
    expect(breaker.snapshot().state).toBe("open");
    const started = performance.now();
    await expect(embedForRecall(down, "q", {}, 1000, breaker)).rejects.toThrow(/circuit open/);
    expect(performance.now() - started).toBeLessThan(50);
    expect(down.calls).toBe(FAILURE_THRESHOLD);
  });

  it("counts a full-budget timeout, but not a caller cancel or a short request deadline", async () => {
    const hang = client((_t, _k, o) => new Promise((_, reject) => o?.signal?.addEventListener("abort", () => reject(o.signal!.reason))));
    const breaker = createCircuitBreaker();
    const cancelled = new AbortController();
    const pending = embedForRecall(hang, "q", { signal: cancelled.signal }, 1000, breaker);
    cancelled.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMUnreachableError);
    await expect(embedForRecall(hang, "q", { deadlineAt: performance.now() + 10 }, 1000, breaker)).rejects.toBeInstanceOf(LLMUnreachableError);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    await expect(embedForRecall(hang, "q", {}, 10, breaker)).rejects.toBeInstanceOf(LLMUnreachableError);
    expect(breaker.snapshot().consecutiveFailures).toBe(1);
  });

  it("a success resets the count", async () => {
    const breaker = createCircuitBreaker();
    breaker.failure("x");
    await embedForRecall(client(async () => vector), "q", {}, 1000, breaker);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });
});
