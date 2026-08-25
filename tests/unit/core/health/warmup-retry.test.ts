// A one-shot warmup with a swallowed catch turns a transient backend outage
// into a permanent false state, and one that survives restarts, so it reads as
// a deterministic code bug. That cost three weeks on a 0.21.5 "embedder
// regression" that did not exist, plus a five-day silent outage where the
// embedder was reachable the whole time and only a daemon restart cleared it.
import { describe, expect, it, vi } from "vitest";
import { retryUntilWarm } from "../../../../src/core/health/warmup-retry.js";

function harness(overrides: Partial<Parameters<typeof retryUntilWarm>[0]> = {}) {
  const slept: number[] = [];
  const failures: Array<{ reason: string; attempt: number }> = [];
  let warmed = 0;
  return {
    slept,
    failures,
    warmed: () => warmed,
    deps: {
      attempt: vi.fn().mockResolvedValue(undefined),
      onSuccess: () => { warmed += 1; },
      onFailure: (reason: string, attempt: number) => { failures.push({ reason, attempt }); },
      sleep: async (ms: number) => { slept.push(ms); },
      ...overrides,
    },
  };
}

describe("retryUntilWarm", () => {
  it("marks warm on the first attempt and never sleeps", async () => {
    const h = harness();
    await retryUntilWarm(h.deps);
    expect(h.warmed()).toBe(1);
    expect(h.slept).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("keeps retrying until the backend comes back, then marks warm once", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(undefined);
    const h = harness({ attempt });
    await retryUntilWarm(h.deps);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(h.warmed()).toBe(1);
    expect(h.slept.length).toBe(2);
  });

  it("reports every failure with its reason so health can name the cause", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("model not loaded"))
      .mockResolvedValue(undefined);
    const h = harness({ attempt });
    await retryUntilWarm(h.deps);
    expect(h.failures).toEqual([{ reason: "model not loaded", attempt: 1 }]);
  });

  it("backs off exponentially but caps the delay", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("down"));
    const h = harness({ attempt });
    await retryUntilWarm({ ...h.deps, maxAttempts: 8, baseDelayMs: 100, maxDelayMs: 500 });
    expect(h.slept).toEqual([100, 200, 400, 500, 500, 500, 500]);
    expect(h.warmed()).toBe(0);
  });

  it("gives up after maxAttempts rather than looping forever", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("down"));
    const h = harness({ attempt });
    await retryUntilWarm({ ...h.deps, maxAttempts: 3 });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(h.failures.length).toBe(3);
  });

  it("never throws, so a dead embedder cannot take the daemon down", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));
    const onFailure = () => { throw new Error("reporter exploded"); };
    await expect(
      retryUntilWarm({ ...harness({ attempt }).deps, onFailure, maxAttempts: 2 }),
    ).resolves.toBeUndefined();
  });
});
