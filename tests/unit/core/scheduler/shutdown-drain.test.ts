import { describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";

describe("scheduler shutdown", () => {
  it("waits for the current tick before draining", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new ScanScheduler({
      store: { rawDb: () => null } as never,
      adapters: [], classifier: {} as never, logger: () => {},
      diskGuard: { shouldSkip: async () => { entered(); await waiting; return true; } },
    });
    const tick = scheduler.tick();
    await started;
    scheduler.stop();
    let done = false;
    const drain = scheduler.drain().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await tick;
    await drain;
    expect(done).toBe(true);
  });
});
