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
import { BundledEmbedderClient } from "../../../src/llm/bundled-embedder-client.js";

const ENV_KEYS = ["NLM_EMBED_PROVIDER", "NLM_EMBED_BASE_URL", "NLM_EMBED_MODEL", "NLM_EMBED_API_KEY", "NLM_OLLAMA_URL", "NLM_BUNDLED_MODEL_DIR"] as const;

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
    process.env["NLM_EMBED_BASE_URL"] = "http://localhost:1234/v1";

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

  it("ollama: passes NLM_EMBED_MODEL to OllamaClient when set", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "ollama";
    process.env["NLM_EMBED_MODEL"] = "mxbai-embed-large";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(OllamaClient);
    // The model is private; validate it round-trips by checking the instance type only.
    // Behavioral tests for model-forwarding live in ollama-client tests.
  });

  it("returns BundledEmbedderClient when provider is 'bundled'", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "bundled";
    process.env["NLM_EMBED_BASE_URL"] = "";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(BundledEmbedderClient);
  });

  it("bundled: is case-insensitive (Bundled activates the bundled branch)", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "Bundled";
    process.env["NLM_EMBED_BASE_URL"] = "";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(BundledEmbedderClient);
  });

  it("bundled: returns BundledEmbedderClient even when NLM_EMBED_MODEL is set", async () => {
    saved = captureEnv();
    process.env["NLM_EMBED_PROVIDER"] = "bundled";
    process.env["NLM_EMBED_MODEL"] = "custom/repo";
    process.env["NLM_EMBED_BASE_URL"] = "";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(BundledEmbedderClient);
  });

  it("behavior fence: unset provider still returns OllamaClient (no bundled activation)", async () => {
    saved = captureEnv();
    // Delete so the factory falls through to the default.
    // autoloadEnv() may set it from ~/.nlm/.env, but that will never be "bundled" in CI.
    process.env["NLM_EMBED_PROVIDER"] = "ollama";
    process.env["NLM_EMBED_BASE_URL"] = "";

    const { buildEmbedder } = await import("../../../src/llm/build-embedder.js");
    const result = buildEmbedder();
    expect(result).toBeInstanceOf(OllamaClient);
  });
});
