import { describe, expect, it } from "vitest";
import { laneEnv, laneValues, resolveEmbedderLane } from "../../../../src/core/embedding/embedder-config.js";
import { NO_STORED_EMBEDDER } from "../../../../src/ports/embedder-settings-store.js";

const PROD_ENV = {
  NLM_EMBED_PROVIDER: "openai",
  NLM_EMBED_BASE_URL: "http://192.168.2.2:4000/v1",
  NLM_EMBED_MODEL: "text-embedding-embeddinggemma-2-oq8e",
  NLM_EMBED_API_KEY: "sk-live-secret",
};

describe("resolveEmbedderLane", () => {
  it("reports the production env config with source 'env' when nothing is stored", () => {
    const s = resolveEmbedderLane("prose", NO_STORED_EMBEDDER, PROD_ENV);
    expect(s.provider).toEqual({ value: "openai", source: "env" });
    expect(s.baseUrl).toEqual({ value: "http://192.168.2.2:4000/v1", source: "env" });
    expect(s.model).toEqual({ value: "text-embedding-embeddinggemma-2-oq8e", source: "env" });
    expect(s.apiKey.source).toBe("env");
  });

  it("code lane follows the prose provider/base_url/key env but takes its model from NLM_CODE_EMBED_MODEL, defaulting when unset", () => {
    const withModel = resolveEmbedderLane("code", NO_STORED_EMBEDDER, { ...PROD_ENV, NLM_CODE_EMBED_MODEL: "text-embedding-coderankembed" });
    expect(withModel.model).toEqual({ value: "text-embedding-coderankembed", source: "env" });
    expect(withModel.baseUrl.value).toBe("http://192.168.2.2:4000/v1");
    const sameAsProse = resolveEmbedderLane("code", NO_STORED_EMBEDDER, PROD_ENV);
    expect(sameAsProse.model.source).toBe("default");
    expect(sameAsProse.model.value).not.toBe("text-embedding-embeddinggemma-2-oq8e");
  });

  it("a stored value beats env, and null falls through per field", () => {
    const s = resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, model: "other-model", apiKey: "stored-key" }, PROD_ENV);
    expect(s.model).toEqual({ value: "other-model", source: "setting" });
    expect(s.apiKey).toEqual({ value: "stored-key", source: "setting" });
    expect(s.provider.source).toBe("env");
  });

  it("falls back to ollama defaults with source 'default'", () => {
    const s = resolveEmbedderLane("prose", NO_STORED_EMBEDDER, {});
    expect(s.provider).toEqual({ value: "ollama", source: "default" });
    expect(s.baseUrl).toEqual({ value: "http://localhost:11434", source: "default" });
    expect(s.model).toEqual({ value: "nomic-embed-text", source: "default" });
    expect(s.apiKey).toEqual({ value: null, source: "default" });
  });

  it("an ollama lane reads its base URL from NLM_OLLAMA_URL, not NLM_EMBED_BASE_URL", () => {
    const s = resolveEmbedderLane("prose", NO_STORED_EMBEDDER, { NLM_OLLAMA_URL: "http://ollama:11434", NLM_EMBED_BASE_URL: "http://other/v1" });
    expect(s.baseUrl).toEqual({ value: "http://ollama:11434", source: "env" });
  });
});

describe("env API key scope", () => {
  it("applies only while provider and base_url still resolve to the env endpoint", () => {
    const same = resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, baseUrl: "http://192.168.2.2:4000/v1", model: "x" }, PROD_ENV);
    expect(same.apiKey).toEqual({ value: "sk-live-secret", source: "env" });
    const moved = resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, baseUrl: "http://elsewhere/v1" }, PROD_ENV);
    expect(moved.apiKey).toEqual({ value: null, source: "default" });
    const switched = resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, provider: "ollama" }, PROD_ENV);
    expect(switched.apiKey.value).toBeNull();
  });

  it("a stored key is explicit and always applies", () => {
    const s = resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, baseUrl: "http://elsewhere/v1", apiKey: "k" }, PROD_ENV);
    expect(s.apiKey).toEqual({ value: "k", source: "setting" });
  });
});

describe("laneEnv", () => {
  it("blanks the key for a lane with none so the child never inherits the daemon's", () => {
    const v = laneValues(resolveEmbedderLane("prose", { ...NO_STORED_EMBEDDER, baseUrl: "http://elsewhere/v1" }, PROD_ENV));
    expect(laneEnv("prose", v)["NLM_EMBED_API_KEY"]).toBe("");
  });

  it("round-trips the effective config into the env buildEmbedder reads, key included", () => {
    const values = laneValues(resolveEmbedderLane("prose", NO_STORED_EMBEDDER, PROD_ENV));
    const env = laneEnv("prose", values);
    expect(env).toEqual(PROD_ENV);
    expect(laneValues(resolveEmbedderLane("prose", NO_STORED_EMBEDDER, env))).toEqual(values);
  });

  it("the code lane carries its model in NLM_CODE_EMBED_MODEL and never NLM_EMBED_MODEL", () => {
    const values = laneValues(resolveEmbedderLane("code", { ...NO_STORED_EMBEDDER, model: "my-code-model" }, PROD_ENV));
    const env = laneEnv("code", values);
    expect(env["NLM_CODE_EMBED_MODEL"]).toBe("my-code-model");
    expect(env).not.toHaveProperty("NLM_EMBED_MODEL");
    expect(laneValues(resolveEmbedderLane("code", NO_STORED_EMBEDDER, env)).model).toBe("my-code-model");
  });
});
