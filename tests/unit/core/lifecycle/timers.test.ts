import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedTimers } from "../../../../src/core/lifecycle/timers.js";

afterEach(() => { vi.useRealTimers(); });

describe("ManagedTimers", () => {
  it("cancels every pending timer and rejects post-stop scheduling", () => {
    vi.useFakeTimers();
    const timers = new ManagedTimers();
    const interval = vi.fn();
    const once = vi.fn();
    timers.interval(interval, 10);
    timers.timeout(once, 25);
    vi.advanceTimersByTime(12);
    expect(interval).toHaveBeenCalledTimes(1);
    timers.stop();
    timers.stop();
    vi.advanceTimersByTime(100);
    expect(interval).toHaveBeenCalledTimes(1);
    expect(once).not.toHaveBeenCalled();
    expect(() => timers.timeout(once, 1)).toThrow("timers are stopped");
    expect(vi.getTimerCount()).toBe(0);
  });
});
