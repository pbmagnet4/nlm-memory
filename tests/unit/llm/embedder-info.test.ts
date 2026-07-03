import { describe, expect, it } from "vitest";
import { resolveEmbedderInfo } from "../../../src/llm/embedder-info.js";
import { DEFAULT_OPENAI_EMBED_MODEL } from "../../../src/llm/openai-embedder-client.js";
import { DEFAULT_MODEL_REPO } from "../../../src/llm/bundled-embedder-client.js";

describe("resolveEmbedderInfo", () => {
  it("defaults to local ollama nomic when NLM_EMBED_PROVIDER is unset", () => {
    expect(resolveEmbedderInfo({})).toEqual({ provider: "ollama", model: "nomic-embed-text", dims: 768 });
  });

  it("reports the openai provider with NLM_EMBED_MODEL when set", () => {
    const info = resolveEmbedderInfo({
      NLM_EMBED_PROVIDER: "openai",
      NLM_EMBED_MODEL: "text-embedding-coderankembed",
    });
    expect(info).toEqual({ provider: "openai", model: "text-embedding-coderankembed", dims: 768 });
  });

  it("falls back to the client's default openai model when NLM_EMBED_MODEL is unset", () => {
    const info = resolveEmbedderInfo({ NLM_EMBED_PROVIDER: "openai" });
    expect(info.provider).toBe("openai");
    expect(info.model).toBe(DEFAULT_OPENAI_EMBED_MODEL);
  });

  it("is case-insensitive on the provider", () => {
    expect(resolveEmbedderInfo({ NLM_EMBED_PROVIDER: "OpenAI" }).provider).toBe("openai");
  });

  it("ollama provider uses NLM_EMBED_MODEL when set", () => {
    const info = resolveEmbedderInfo({ NLM_EMBED_MODEL: "mxbai-embed-large" });
    expect(info.provider).toBe("ollama");
    expect(info.model).toBe("mxbai-embed-large");
  });

  it("ollama provider falls back to nomic-embed-text when NLM_EMBED_MODEL is unset", () => {
    const info = resolveEmbedderInfo({});
    expect(info.model).toBe("nomic-embed-text");
  });

  it("bundled provider defaults to DEFAULT_MODEL_REPO when NLM_EMBED_MODEL is unset", () => {
    const info = resolveEmbedderInfo({ NLM_EMBED_PROVIDER: "bundled" });
    expect(info.provider).toBe("bundled");
    expect(info.model).toBe(DEFAULT_MODEL_REPO);
    expect(info.dims).toBe(768);
  });

  it("bundled provider uses NLM_EMBED_MODEL when set", () => {
    const info = resolveEmbedderInfo({ NLM_EMBED_PROVIDER: "bundled", NLM_EMBED_MODEL: "custom/repo" });
    expect(info.provider).toBe("bundled");
    expect(info.model).toBe("custom/repo");
  });

  it("bundled provider is case-insensitive on the provider value", () => {
    expect(resolveEmbedderInfo({ NLM_EMBED_PROVIDER: "Bundled" }).provider).toBe("bundled");
  });

  it("behavior fence: unset provider does not activate bundled (stays ollama)", () => {
    const info = resolveEmbedderInfo({});
    expect(info.provider).toBe("ollama");
    expect(info.model).toBe("nomic-embed-text");
  });
});
