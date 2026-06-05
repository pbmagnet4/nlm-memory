import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
