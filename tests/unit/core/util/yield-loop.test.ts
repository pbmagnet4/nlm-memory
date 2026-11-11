import { describe, expect, it } from "vitest";
import { yieldToEventLoop } from "@core/util/yield-loop.js";

/** The whole point of the helper (T679): the loop gets a turn, so queued I/O is
 *  serviced rather than queueing behind the next batch of synchronous SQLite
 *  work. A timer must not fire on the way out, and an already-armed immediate
 *  must run before the continuation's successor does. */
describe("yieldToEventLoop", () => {
  it("resolves without running timers", async () => {
    const order: string[] = [];
    const timer = setTimeout(() => order.push("timer-must-not-run"), 0);
    await yieldToEventLoop();
    order.push("after-yield");
    clearTimeout(timer);
    expect(order).toEqual(["after-yield"]);
  });

  it("lets an already-armed immediate go first", async () => {
    const order: string[] = [];
    await yieldToEventLoop();
    setImmediate(() => order.push("armed-before"));
    order.push("after-yield");
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    // The immediate armed before this continuation's own setImmediate runs first.
    expect(order).toEqual(["after-yield", "armed-before"]);
  });
});
