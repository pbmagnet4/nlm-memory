// tests/unit/hook/deadline-invariant.test.ts
//
// Pins the relationship between the outer hook deadline and the inner recall
// HTTP timeout so neither can be lowered blindly without breaking the other.
//
// WHY (#396): the passive recall layer went silent because the hook's
// RECALL_TIMEOUT_MS (2000ms) lost the race against the daemon's sequential
// hybrid recall floor (~2300ms), so the hook gave up before results arrived.
// Raising RECALL_TIMEOUT_MS to 4000ms while keeping the outer at 4000ms
// would re-create the squeeze one level up (recall could consume the whole
// outer budget, starving gate + formatting). The outer must always
// exceed the inner to leave headroom for gate + formatting work.

import { describe, expect, it } from "vitest";
import { RECALL_TIMEOUT_MS } from "../../../src/hook/recall-over-http.js";
import { HOOK_DEADLINE_MS } from "../../../src/hook/prompt-recall-hook.js";

describe("hook deadline invariant (#396)", () => {
  it("outer HOOK_DEADLINE_MS exceeds inner RECALL_TIMEOUT_MS at defaults", () => {
    expect(HOOK_DEADLINE_MS).toBeGreaterThan(RECALL_TIMEOUT_MS);
  });
});
