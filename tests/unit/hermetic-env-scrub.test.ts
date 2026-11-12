import { describe, expect, it } from "vitest";
import { scrubOperatorEnv } from "../setup/hermetic-env.js";

describe("scrubOperatorEnv (T1760)", () => {
  it("drops NLM_* deployment config and the non-prefixed app config", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/operator",
      TMPDIR: "/tmp",
      NODE_ENV: "test",
      VITEST: "true",
      NLM_FORMAT: "toon",
      NLM_PORT: "8787",
      NLM_DREAM_PROMOTE_PASS: "1",
      NLM_DREAM_PROMOTE_APPLY: "1",
      NLM_HOSTED: "1",
      DEEPSEEK_API_KEY: "sk-live",
      TELEGRAM_BOT_TOKEN: "123-live-token",
      PI_SESSIONS_PATH: "/Users/operator/.pi/sessions",
      // Suite-owned floors, injected by vitest.config.ts / CI:
      NLM_STATE_ROOT: "/tmp/nlm-test-state-x",
      NLM_RECALL_REWRITE_DEFAULT: "false",
      NLM_PG_TEST_URL: "pg-test-url-sentinel",
    };
    expect(scrubOperatorEnv(env)).toEqual([
      "DEEPSEEK_API_KEY",
      "NLM_DREAM_PROMOTE_APPLY",
      "NLM_DREAM_PROMOTE_PASS",
      "NLM_FORMAT",
      "NLM_HOSTED",
      "NLM_PORT",
      "PI_SESSIONS_PATH",
      "TELEGRAM_BOT_TOKEN",
    ]);
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/operator",
      TMPDIR: "/tmp",
      NODE_ENV: "test",
      VITEST: "true",
      NLM_STATE_ROOT: "/tmp/nlm-test-state-x",
      NLM_RECALL_REWRITE_DEFAULT: "false",
      NLM_PG_TEST_URL: "pg-test-url-sentinel",
    });
  });

  it("is a no-op on an already clean environment", () => {
    expect(scrubOperatorEnv({ PATH: "/usr/bin" })).toEqual([]);
  });
});
