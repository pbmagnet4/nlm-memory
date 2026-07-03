import { beforeEach, describe, expect, it, vi } from "vitest";
import { BundledEmbedderClient, DEFAULT_BUNDLED_EMBED_MODEL } from "../../../src/llm/bundled-embedder-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";
import { MAX_EMBED_CHARS } from "../../../src/llm/ollama-client.js";

const mockEmbedFn = vi.fn();
const mockPipelineFactory = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
}));

function make768Vec(): Float32Array {
  const v = new Float32Array(768);
  // Non-zero at [0,1] so l2Normalize produces a verifiable result: [0.6, 0.8, ...]
  v[0] = 3;
  v[1] = 4;
  return v;
}

describe("BundledEmbedderClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEmbedFn.mockResolvedValue({ data: make768Vec() });
    mockPipelineFactory.mockResolvedValue(mockEmbedFn);
  });

  describe("prefix by kind", () => {
    it("prepends search_document prefix for document embeddings", async () => {
      const client = new BundledEmbedderClient();
      await client.embed("hello world", "document");
      expect(mockEmbedFn).toHaveBeenCalledWith("search_document: hello world", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("prepends search_query prefix for query embeddings", async () => {
      const client = new BundledEmbedderClient();
      await client.embed("find this", "query");
      expect(mockEmbedFn).toHaveBeenCalledWith("search_query: find this", {
        pooling: "mean",
        normalize: true,
      });
    });
  });

  describe("truncation", () => {
    it("truncates input at MAX_EMBED_CHARS before adding the prefix", async () => {
      const client = new BundledEmbedderClient();
      const longText = "a".repeat(MAX_EMBED_CHARS + 100);
      await client.embed(longText, "document");
      const calledText = mockEmbedFn.mock.calls[0]?.[0] as string;
      expect(calledText).toBe(`search_document: ${"a".repeat(MAX_EMBED_CHARS)}`);
    });
  });

  describe("output shape", () => {
    it("returns a L2-normalized Float32Array vector", async () => {
      const client = new BundledEmbedderClient();
      const result = await client.embed("test", "document");
      expect(result.vector).toBeInstanceOf(Float32Array);
      const norm = Math.hypot(...Array.from(result.vector));
      expect(norm).toBeCloseTo(1, 5);
      expect(result.vector[0]).toBeCloseTo(0.6, 5);
      expect(result.vector[1]).toBeCloseTo(0.8, 5);
    });

    it("reports the model name in EmbedResult", async () => {
      const client = new BundledEmbedderClient();
      const result = await client.embed("test", "query");
      expect(result.model).toBe(DEFAULT_BUNDLED_EMBED_MODEL);
    });
  });

  describe("dimension validation", () => {
    it("throws LLMUnreachableError when the pipeline yields non-768 dimensions", async () => {
      mockEmbedFn.mockResolvedValue({ data: new Float32Array(64) });
      const client = new BundledEmbedderClient();
      await expect(client.embed("test", "document")).rejects.toBeInstanceOf(LLMUnreachableError);
    });
  });

  describe("lazy init", () => {
    it("initializes the pipeline only once across multiple embed calls", async () => {
      const client = new BundledEmbedderClient();
      await client.embed("first", "document");
      await client.embed("second", "query");
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });
  });

  describe("import failure", () => {
    it("rejects with LLMUnreachableError when pipeline initialization fails", async () => {
      mockPipelineFactory.mockRejectedValue(new Error("module unavailable"));
      const client = new BundledEmbedderClient();
      await expect(client.embed("test", "document")).rejects.toBeInstanceOf(LLMUnreachableError);
    });
  });

  describe("unsupported methods", () => {
    it("classify throws LLMUnreachableError (embedder only)", async () => {
      const client = new BundledEmbedderClient();
      await expect(client.classify("transcript")).rejects.toBeInstanceOf(LLMUnreachableError);
    });

    it("rewriteForRecall throws LLMUnreachableError (embedder only)", async () => {
      const client = new BundledEmbedderClient();
      await expect(client.rewriteForRecall("query")).rejects.toBeInstanceOf(LLMUnreachableError);
    });
  });
});
