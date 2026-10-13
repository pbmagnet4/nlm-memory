import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "../../../src/core/util/with-timeout.js";

const slow = () => new Promise((r) => setTimeout(() => r("late"), 1000));

describe("withTimeout", () => {
  it("resolves fast work", async () => {
    await expect(withTimeout(async () => 42, 1000)).resolves.toBe(42);
  });
  it("rejects with TimeoutError when the work is too slow", async () => {
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });
  it("TimeoutError is instanceof Error", async () => {
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(Error);
  });
  it("aborts the work's signal at the deadline so it stops running", async () => {
    let signal: AbortSignal | undefined;
    await expect(withTimeout((s) => { signal = s; return slow(); }, 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(signal?.aborted).toBe(true);
  });
});
