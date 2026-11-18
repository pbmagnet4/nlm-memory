import { describe, expect, it } from "vitest";
import { WorkTracker } from "../../../../src/core/lifecycle/work-tracker.js";

describe("WorkTracker", () => {
  it("waits for admitted requests and work they start after admission closes", async () => {
    const tracker = new WorkTracker();
    const done = tracker.beginRequest()!;
    tracker.stopAdmission();
    expect(tracker.beginRequest()).toBeUndefined();
    let finish!: () => void;
    let drained = false;
    const draining = tracker.drain().then(() => { drained = true; });
    tracker.track(new Promise<void>((resolve) => { finish = resolve; }));
    done();
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it("settles rejected background work without blocking the drain", async () => {
    const tracker = new WorkTracker();
    const work = tracker.track(Promise.reject(new Error("test")));
    await expect(work).rejects.toThrow("test");
    await expect(tracker.drain()).resolves.toBeUndefined();
  });
});
