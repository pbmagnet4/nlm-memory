import { describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownSteps } from "../../../../src/core/lifecycle/shutdown.js";

describe("shutdown coordination", () => {
  it("stops admission and workers before awaiting work, then closes storage exactly once", async () => {
    const events: string[] = [];
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const steps: ShutdownSteps = {
      stopAdmission: () => { events.push("admission"); },
      cancelTimers: () => { events.push("timers"); },
      closeServer: async () => { events.push("server"); },
      stopWorkers: () => { events.push("workers"); },
      drain: async () => { events.push("drain"); await blocked; },
      closeStorage: async () => { events.push("storage"); },
    };
    const shutdown = createShutdown(steps, 1000);
    const first = shutdown();
    expect(shutdown()).toBe(first);
    expect(events).toEqual(["admission", "timers", "server", "workers", "drain"]);
    finish();
    await first;
    expect(events.at(-1)).toBe("storage");
  });

  it("never closes storage after a timeout or failed drain", async () => {
    const closeStorage = vi.fn(async () => {});
    const base: ShutdownSteps = {
      stopAdmission: () => {}, cancelTimers: () => {}, closeServer: async () => {},
      stopWorkers: () => {}, drain: () => new Promise(() => {}), closeStorage,
    };
    await expect(createShutdown(base, 5)()).rejects.toThrow("shutdown timed out");
    expect(closeStorage).not.toHaveBeenCalled();
    await expect(createShutdown({ ...base, drain: async () => { throw new Error("drain failed"); } }, 1000)()).rejects.toThrow("drain failed");
    expect(closeStorage).not.toHaveBeenCalled();
  });

  it("bounds a stalled storage close", async () => {
    const closeStorage = vi.fn(() => new Promise<void>(() => {}));
    const steps: ShutdownSteps = {
      stopAdmission: () => {}, cancelTimers: () => {}, closeServer: async () => {},
      stopWorkers: () => {}, drain: async () => {}, closeStorage,
    };
    await expect(createShutdown(steps, 5)()).rejects.toThrow("shutdown timed out");
    expect(closeStorage).toHaveBeenCalledOnce();
  });
});
