import { describe, expect, it } from "vitest";
import { classifyLarge } from "../../../../src/core/classifier/hierarchical-classify.js";
import { createLimiter, limiterFromEnv } from "../../../../src/core/classifier/inflight-limiter.js";
import { isTransientLLMError } from "../../../../src/core/classifier/transient-error.js";
import { LLMUnreachableError, ClassifierSchemaError } from "../../../../src/ports/llm-client.js";
import { TimeoutError } from "../../../../src/core/util/with-timeout.js";
import type { ClassifyResult, LLMClient } from "../../../../src/ports/llm-client.js";

const BIG = "x".repeat(130_000); // 3+ chunks at 40k with overlap

function result(label: string): ClassifyResult {
  return { label, summary: label, entities: [], decisions: [], open: [], confidence: 0.9, facts: [] };
}

function fakeClient(delayMs: number, onCall?: (n: number) => Promise<void> | void) {
  let inflight = 0;
  let max = 0;
  let calls = 0;
  const client = {
    classify: async (_t: string, opts?: { signal?: AbortSignal }) => {
      const n = ++calls;
      inflight += 1;
      max = Math.max(max, inflight);
      try {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, delayMs);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
        });
        await onCall?.(n);
        return result(`c${n}`);
      } finally {
        inflight -= 1;
      }
    },
  } as unknown as LLMClient;
  return { client, maxInflight: () => max, calls: () => calls };
}

describe("in-flight cap", () => {
  it("N=1 with 3 chunks never exceeds 1 in flight", async () => {
    const f = fakeClient(10);
    await classifyLarge(BIG, f.client, { limiter: createLimiter(1) });
    expect(f.calls()).toBeGreaterThanOrEqual(3);
    expect(f.maxInflight()).toBe(1);
  });
  it("N=2 reaches 2 in flight", async () => {
    const f = fakeClient(10);
    await classifyLarge(BIG, f.client, { limiter: createLimiter(2) });
    expect(f.maxInflight()).toBe(2);
  });
  it("limiter is shared across callers", async () => {
    const lim = createLimiter(1);
    const f = fakeClient(10);
    await Promise.all([classifyLarge(BIG, f.client, { limiter: lim }), classifyLarge(BIG, f.client, { limiter: lim })]);
    expect(f.maxInflight()).toBe(1);
  });
  it("reads NLM_CLASSIFY_MAX_INFLIGHT, default 1, ignores junk", () => {
    expect(limiterFromEnv({}).max).toBe(1);
    expect(limiterFromEnv({ NLM_CLASSIFY_MAX_INFLIGHT: "3" }).max).toBe(3);
    expect(limiterFromEnv({ NLM_CLASSIFY_MAX_INFLIGHT: "0" }).max).toBe(1);
    expect(limiterFromEnv({ NLM_CLASSIFY_MAX_INFLIGHT: "abc" }).max).toBe(1);
  });
});

describe("per-chunk budget", () => {
  it("total time scales with chunk count: 5 chunks x 60ms succeed under a 100ms per-chunk budget", async () => {
    const f = fakeClient(60);
    const big = "y".repeat(190_000);
    const started = Date.now();
    const r = await classifyLarge(big, f.client, { limiter: createLimiter(1), perCallTimeoutMs: 100 });
    expect(f.calls()).toBeGreaterThanOrEqual(5);
    expect(Date.now() - started).toBeGreaterThan(100);
    expect(r.label).toBe("c1");
  });
  it("keeps chunks that succeed when another times out", async () => {
    let n = 0;
    const client = {
      classify: async (_t: string, opts?: { signal?: AbortSignal }) => {
        const mine = ++n;
        if (mine === 2) await new Promise((_, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
        return result(`c${mine}`);
      },
    } as unknown as LLMClient;
    const r = await classifyLarge(BIG, client, { limiter: createLimiter(1), perCallTimeoutMs: 30 });
    expect(r.label).toBe("c1");
  });
  it("keeps the first chunk error as the cause when every chunk fails", async () => {
    const err = new LLMUnreachableError("x", "status 500");
    const client = { classify: async () => { throw err; } } as unknown as LLMClient;
    const thrown = await classifyLarge(BIG, client, { limiter: createLimiter(1) }).catch((e: unknown) => e);
    expect((thrown as Error).cause).toBe(err);
    expect(isTransientLLMError(thrown)).toBe(true);
  });
});

describe("isTransientLLMError", () => {
  it("classifies infrastructure vs quality failures", () => {
    expect(isTransientLLMError(new TimeoutError("timed out after 5ms"))).toBe(true);
    expect(isTransientLLMError(new LLMUnreachableError("openai", "status 500"))).toBe(true);
    expect(isTransientLLMError(new LLMUnreachableError("openai", new Error("fetch failed")))).toBe(true);
    expect(isTransientLLMError(new LLMUnreachableError("openai"))).toBe(true);
    expect(isTransientLLMError(new LLMUnreachableError("openai", "status 401"))).toBe(false);
    expect(isTransientLLMError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientLLMError(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(isTransientLLMError(new ClassifierSchemaError("returned non-JSON content"))).toBe(false);
    expect(isTransientLLMError(new Error("boom"))).toBe(false);
  });
});
