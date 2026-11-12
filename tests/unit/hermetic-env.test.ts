import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

// Deliberately no import of tests/setup/hermetic-env.js here: importing it runs
// the scrub again in this worker, which would make these assertions pass even
// when the setup file is missing from the config. The scrub itself is unit-
// tested in hermetic-env-scrub.test.ts.
//
// Captured at module import — after vitest.config.ts injected its `env` floors
// and ran setupFiles, before any test body (so before any vi.stubEnv).
const FORMAT_AT_IMPORT = process.env.NLM_FORMAT;
const STATE_ROOT_AT_IMPORT = process.env.NLM_STATE_ROOT;

describe("hermetic test environment (T1760)", () => {
  it("does not leak an exported NLM_FORMAT=toon into the suite", () => {
    // `NLM_FORMAT=toon npm test` fails here without the setup file — the exact
    // shape of the mcp-context.test.ts JSON/TOON break.
    expect(FORMAT_AT_IMPORT).toBeUndefined();
    expect(process.env.NLM_FORMAT).toBeUndefined();
  });

  it("scrubs the rest of the deployment environment but keeps the toolchain", () => {
    expect(process.env.NLM_DREAM_PROMOTE_PASS).toBeUndefined();
    expect(process.env.NLM_DREAM_PROMOTE_APPLY).toBeUndefined();
    expect(typeof process.env.PATH).toBe("string");
    expect(typeof process.env.HOME).toBe("string");
  });

  it("keeps the state-root floor the config injects, outside the live store", () => {
    // Proves the scrub did not clobber what vitest.config.ts injects, whatever
    // order the two land in.
    expect(STATE_ROOT_AT_IMPORT).toBeDefined();
    expect(STATE_ROOT_AT_IMPORT!.startsWith(tmpdir())).toBe(true);
  });
});
