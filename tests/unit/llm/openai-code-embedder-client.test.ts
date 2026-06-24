import { describe, expect, it } from "vitest";
import { OpenAICodeEmbedderClient } from "../../../src/llm/openai-code-embedder-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";

function recordingFetch(embedding: number[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ data: [{ embedding }] }), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAICodeEmbedderClient.embed", () => {
  it("prefixes queries with the CodeRankEmbed convention and POSTs to {baseUrl}/embeddings", async () => {
    const { calls, fetchImpl } = recordingFetch([3, 4]);
    const client = new OpenAICodeEmbedderClient({
      baseUrl: "http://localhost:1234/v1",
      model: "text-embedding-coderankembed",
      fetchImpl,
    });
    await client.embed("how to add two numbers", "query");
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/embeddings");
    expect(calls[0]!.body.model).toBe("text-embedding-coderankembed");
    expect(calls[0]!.body.input).toBe("Represent this query for searching relevant code: how to add two numbers");
  });

  it("embeds documents raw (no prefix) for CodeRankEmbed", async () => {
    const { calls, fetchImpl } = recordingFetch([1, 0]);
    const client = new OpenAICodeEmbedderClient({ baseUrl: "http://h:1234/v1", model: "text-embedding-coderankembed", fetchImpl });
    await client.embed("def add(a,b): return a+b", "document");
    expect(calls[0]!.body.input).toBe("def add(a,b): return a+b");
  });

  it("uses nomic prefixes when the model is a nomic fallback", async () => {
    const { calls, fetchImpl } = recordingFetch([1, 0]);
    const client = new OpenAICodeEmbedderClient({ baseUrl: "http://h:1234/v1", model: "nomic-embed-text", fetchImpl });
    await client.embed("x", "document");
    expect(calls[0]!.body.input).toBe("search_document: x");
  });

  it("L2-normalizes and reports the dim", async () => {
    const { fetchImpl } = recordingFetch([3, 4]);
    const client = new OpenAICodeEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    const res = await client.embed("x", "document");
    expect(Math.hypot(...Array.from(res.vector))).toBeCloseTo(1, 5);
    expect(res.dim).toBe(2);
  });

  it("throws LLMUnreachableError on a non-ok response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }) as unknown as Response) as typeof fetch;
    const client = new OpenAICodeEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    await expect(client.embed("x", "document")).rejects.toBeInstanceOf(LLMUnreachableError);
  });
});
