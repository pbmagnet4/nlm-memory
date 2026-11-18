import { describe, expect, it } from "vitest";
import { WorkTracker } from "../../../../src/core/lifecycle/work-tracker.js";
import { RequestBudget } from "../../../../src/core/recall/request-budget.js";

describe("recall budget shutdown tracking", () => {
  it("retains the underlying operation after its caller times out", async () => {
    const tracker = new WorkTracker();
    const budget = new RequestBudget(5, { workTracker: tracker });
    let release!: () => void;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    await expect(budget.run(() => operation)).rejects.toThrow();
    budget.dispose();
    tracker.stopAdmission();
    let finished = false;
    const drain = tracker.drain().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await drain;
    expect(finished).toBe(true);
  });
});
