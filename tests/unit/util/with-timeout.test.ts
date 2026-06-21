import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "../../../src/core/util/with-timeout.js";

describe("withTimeout", () => {
  it("resolves a fast promise", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
  it("rejects with TimeoutError when the promise is too slow", async () => {
    const slow = new Promise((r) => setTimeout(() => r("late"), 1000));
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });
  it("TimeoutError is instanceof Error", async () => {
    const slow = new Promise((r) => setTimeout(() => r("late"), 1000));
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(Error);
  });
});
