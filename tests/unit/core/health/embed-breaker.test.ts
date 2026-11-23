import { describe, expect, it } from "vitest";
import {
  BASE_COOLDOWN_MS,
  FAILURE_THRESHOLD,
  MAX_COOLDOWN_MS,
  createCircuitBreaker,
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
});
