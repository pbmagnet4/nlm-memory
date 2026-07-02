import { describe, expect, it } from "vitest";
import { resolveEmbedderInfo } from "../../../src/llm/embedder-info.js";
import { DEFAULT_OPENAI_EMBED_MODEL } from "../../../src/llm/openai-embedder-client.js";

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
});
