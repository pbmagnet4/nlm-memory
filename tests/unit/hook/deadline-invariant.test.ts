// tests/unit/hook/deadline-invariant.test.ts
//
// Pins the relationship between the outer hook deadline and the inner recall
// HTTP timeout so neither can be lowered blindly without breaking the other,
// and pins that both are read from the environment lazily.
//
// WHY (#396): the passive recall layer went silent because the hook's
// RECALL_TIMEOUT_MS (2000ms) lost the race against the daemon's sequential
// hybrid recall floor (~2300ms), so the hook gave up before results arrived.
// Raising RECALL_TIMEOUT_MS to 4000ms while keeping the outer at 4000ms
// would re-create the squeeze one level up (recall could consume the whole
// outer budget, starving gate + formatting). The outer must always
// exceed the inner to leave headroom for gate + formatting work.
//
// WHY (lazy reads): the same layer went silent a second time for a different
// reason. Both knobs used to be module-scope consts, but hook entrypoints call
// autoloadEnv() inside main() — after every import has already been evaluated.
// So the consts captured the environment before ~/.nlm/.env was loaded, and
// every value an operator set there was silently ignored. Reading at call time
// is immune to import order; these tests pin that.

import { describe, expect, it, afterEach } from "vitest";
import { recallTimeoutMs } from "../../../src/hook/recall-over-http.js";
import { hookDeadlineMs } from "../../../src/hook/prompt-recall-hook.js";

const ENV_KEYS = ["NLM_HOOK_RECALL_TIMEOUT_MS", "NLM_HOOK_DEADLINE_MS"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("hook deadline invariant (#396)", () => {
  it("outer deadline exceeds inner recall timeout at defaults", () => {
    expect(hookDeadlineMs()).toBeGreaterThan(recallTimeoutMs());
  });
});

describe("hook knobs are read lazily, not at module scope", () => {
  it("picks up an env value set after this module was imported", () => {
    process.env["NLM_HOOK_RECALL_TIMEOUT_MS"] = "9000";
    process.env["NLM_HOOK_DEADLINE_MS"] = "11000";
    expect(recallTimeoutMs()).toBe(9000);
    expect(hookDeadlineMs()).toBe(11000);
  });

  it("falls back to defaults on an invalid value rather than denying all", () => {
    process.env["NLM_HOOK_RECALL_TIMEOUT_MS"] = "not-a-number";
    process.env["NLM_HOOK_DEADLINE_MS"] = "-1";
    expect(recallTimeoutMs()).toBe(4000);
    expect(hookDeadlineMs()).toBe(6000);
  });
});
