/**
 * Unit tests for the shared buildEmbedder() factory.
 * Asserts provider-routing based on NLM_EMBED_* env vars.
 *
 * Hermeticity note: buildEmbedder() calls autoloadEnv() internally, which
 * reads ~/.nlm/.env and sets any env vars that are currently `=== undefined`.
 * Setting a key explicitly in the test (including to "") before calling
 * buildEmbedder() prevents autoloadEnv() from overriding it (it only sets
 * keys that are undefined). We never delete keys before calling buildEmbedder
 * because deletion makes them `=== undefined`, allowing the file to load.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OllamaClient } from "../../../src/llm/ollama-client.js";
import { OpenAIEmbedderClient } from "../../../src/llm/openai-embedder-client.js";

const ENV_KEYS = ["NLM_EMBED_PROVIDER", "NLM_EMBED_BASE_URL", "NLM_EMBED_MODEL", "NLM_EMBED_API_KEY"] as const;

function captureEnv(): Partial<Record<string, string>> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Partial<Record<string, string>>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
}

describe("buildEmbedder", () => {
  let saved: Partial<Record<string, string>>;

  afterEach(() => {
    restoreEnv(saved);
  });

  it("returns OllamaClient when provider is explicitly 'ollama'", async () => {
    saved = captureEnv();
    // Set explicitly so autoloadEnv() won't override with machine's ~/.nlm/.env value.
    process.env["NLM_EMBED_PROVIDER"] = "ollama";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(OllamaClient);
  });

  it("returns OpenAIEmbedderClient when provider is 'openai' and base URL is set", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "openai";
    process.env["NLM_EMBED_BASE_URL"] = "http://192.168.1.217:1234/v1";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(OpenAIEmbedderClient);
  });

  it("throws when provider is 'openai' but NLM_EMBED_BASE_URL is missing", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "openai";
    // Set to "" (not delete) so autoloadEnv() doesn't reload it from ~/.nlm/.env.
    // "" is falsy — the `if (!baseUrl)` guard fires and throws.
    process.env["NLM_EMBED_BASE_URL"] = "";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    expect(() => buildEmbedder()).toThrow("NLM_EMBED_BASE_URL");
  });
});
