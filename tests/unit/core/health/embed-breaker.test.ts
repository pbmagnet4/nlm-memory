import { describe, expect, it, vi } from "vitest";
import {
  BASE_COOLDOWN_MS,
  FAILURE_THRESHOLD,
  MAX_COOLDOWN_MS,
  createCircuitBreaker,
  recallEmbedBreaker,
} from "../../../../src/core/health/embed-breaker.js";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("createCircuitBreaker", () => {
  it("opens after the threshold of consecutive failures and fails fast while open", () => {
    const c = clock();
    const b = createCircuitBreaker(c.now);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) { expect(b.allow()).toBe(true); b.failure("timeout"); }
    expect(b.snapshot().state).toBe("closed");
    expect(b.allow()).toBe(true);
    b.failure("timeout");
    expect(b.snapshot()).toMatchObject({ state: "open", consecutiveFailures: FAILURE_THRESHOLD, lastError: "timeout" });
    expect(b.allow()).toBe(false);
    expect(b.snapshot().shortCircuited).toBe(1);
  });

  it("a success in between resets the count", () => {
    const b = createCircuitBreaker(clock().now);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) b.failure("x");
    b.success();
    b.failure("x");
    expect(b.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 1 });
  });

  it("lets exactly one probe through after the cool-down; its failure doubles the cool-down up to the cap", () => {
    const c = clock();
    const b = createCircuitBreaker(c.now);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) b.failure("down");
    let cooldown = BASE_COOLDOWN_MS;
    for (let round = 0; round < 6; round++) {
      c.advance(cooldown - 1);
      expect(b.allow()).toBe(false);
      c.advance(1);
      expect(b.allow()).toBe(true);
      expect(b.allow()).toBe(false);
      b.failure("still down");
      cooldown = Math.min(cooldown * 2, MAX_COOLDOWN_MS);
      expect(Date.parse(b.snapshot().retryAt!)).toBe(c.now() + cooldown);
    }
    expect(cooldown).toBe(MAX_COOLDOWN_MS);
  });

  it("a successful probe closes it, and a released probe frees the slot without a verdict", () => {
    const c = clock();
    const b = createCircuitBreaker(c.now);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) b.failure("down");
    c.advance(BASE_COOLDOWN_MS);
    expect(b.allow()).toBe(true);
    b.release();
    expect(b.allow()).toBe(true);
    b.success();
    expect(b.snapshot()).toMatchObject({ state: "closed", consecutiveFailures: 0, retryAt: null });
    expect(b.allow()).toBe(true);
  });

  it("reset() returns a breaker to the cold closed state", () => {
    const c = clock();
    const b = createCircuitBreaker(c.now);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) b.failure("down");
    c.advance(BASE_COOLDOWN_MS);
    expect(b.allow()).toBe(true);
    b.failure("still down");
    c.advance(BASE_COOLDOWN_MS);
    expect(b.allow()).toBe(false);
    expect(b.snapshot()).toMatchObject({ state: "open", consecutiveFailures: FAILURE_THRESHOLD + 1, shortCircuited: 1 });

    b.reset();
    expect(b.snapshot()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      retryAt: null,
      lastError: null,
      shortCircuited: 0,
    });
    // The doubled cool-down went with it: a fresh open waits the base again.
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) b.failure("down");
    expect(b.snapshot().state).toBe("closed");
    b.failure("down");
    expect(Date.parse(b.snapshot().retryAt!)).toBe(c.now() + BASE_COOLDOWN_MS);
  });

  it("the process-wide breaker follows a faked global Date", () => {
    // recallEmbedBreaker is built at module load, i.e. long before any test
    // can fake the clock — so it has to read `Date` per call or its cool-down
    // is untestable. tests/integration/fault-injection.test.ts depends on it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      recallEmbedBreaker.reset();
      const t0 = 2_000_000_000_000;
      vi.setSystemTime(t0);
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        expect(recallEmbedBreaker.allow()).toBe(true);
        recallEmbedBreaker.failure("down");
      }
      expect(recallEmbedBreaker.snapshot().state).toBe("open");
      expect(Date.parse(recallEmbedBreaker.snapshot().retryAt!)).toBe(t0 + BASE_COOLDOWN_MS);
      vi.setSystemTime(t0 + BASE_COOLDOWN_MS);
      expect(recallEmbedBreaker.snapshot().state).toBe("half-open");
    } finally {
      vi.useRealTimers();
      recallEmbedBreaker.reset();
    }
  });
});
