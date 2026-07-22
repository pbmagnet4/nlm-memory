// tests/unit/hosted-mode.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHostedMode } from "../../src/core/tenancy/hosted-mode.js";

describe("isHostedMode", () => {
  const ORIGINAL = process.env["NLM_HOSTED"];

  beforeEach(() => {
    delete process.env["NLM_HOSTED"];
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["NLM_HOSTED"];
    else process.env["NLM_HOSTED"] = ORIGINAL;
  });

  it("is false when NLM_HOSTED is unset (local mode, the default)", () => {
    expect(isHostedMode()).toBe(false);
  });

  it("is true when NLM_HOSTED=1", () => {
    process.env["NLM_HOSTED"] = "1";
    expect(isHostedMode()).toBe(true);
  });

  it("is false for any other value", () => {
    process.env["NLM_HOSTED"] = "true";
    expect(isHostedMode()).toBe(false);
    process.env["NLM_HOSTED"] = "0";
    expect(isHostedMode()).toBe(false);
  });
});
