import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every tenant state file (query_log, hook-log, memo state, ...) resolves under
// NLM_STATE_ROOT, defaulting to ~/.nlm. Without this the suite writes into the
// operator's live store: one run of tests/integration/http.test.ts appended 5
// rows to the real query_log.jsonl. That pollution was diagnosed as a rogue
// overnight health prober (~800/day) and cost weeks, because the fixture query
// strings ("probe", "beacon", "smoke") look exactly like a liveness check.
// Individual tests that set NLM_QUERY_LOG still win; this is the floor.
const TEST_STATE_ROOT = mkdtempSync(join(tmpdir(), "nlm-test-state-"));

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Spec C: MCP recall_sessions defaults rewrite=true in production. In
    // tests the LLM stubs throw on rewriteForRecall — disable the default so
    // existing tests don't accidentally trigger the rewrite path. Individual
    // tests that want to exercise rewrite=true flip the env or set the field.
    env: {
      NLM_RECALL_REWRITE_DEFAULT: "false",
      NLM_STATE_ROOT: TEST_STATE_ROOT,
    },
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/ports/**"],
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@ports": fileURLToPath(new URL("./src/ports", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
});
