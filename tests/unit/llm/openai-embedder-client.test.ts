import { describe, expect, it } from "vitest";
import { OpenAIEmbedderClient } from "../../../src/llm/openai-embedder-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";

function recordingFetch(embedding: number[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true,
      json: async () => ({ data: [{ embedding }] }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OpenAIEmbedderClient.embed", () => {
  it("POSTs to {baseUrl}/embeddings with the model and document prefix", async () => {
    const { calls, fetchImpl } = recordingFetch([3, 4]);
    const client = new OpenAIEmbedderClient({
      baseUrl: "http://localhost:1234/v1",
      model: "text-embedding-nomic-embed-text-v1.5",
      fetchImpl,
    });
    await client.embed("hello world", "document");
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/embeddings");
    expect(calls[0]!.body.model).toBe("text-embedding-nomic-embed-text-v1.5");
    expect(calls[0]!.body.input).toBe("search_document: hello world");
  });

  it("uses the search_query prefix for query embeddings", async () => {
    const { calls, fetchImpl } = recordingFetch([1, 0]);
    const client = new OpenAIEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    await client.embed("find this", "query");
    expect(calls[0]!.body.input).toBe("search_query: find this");
  });

  it("L2-normalizes the returned vector (consistent cosine space)", async () => {
    const { fetchImpl } = recordingFetch([3, 4]); // |v| = 5 -> normalized [0.6, 0.8]
    const client = new OpenAIEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    const res = await client.embed("x", "document");
    const norm = Math.hypot(...Array.from(res.vector));
    expect(norm).toBeCloseTo(1, 5);
    expect(res.vector[0]).toBeCloseTo(0.6, 5);
    expect(res.vector[1]).toBeCloseTo(0.8, 5);
    expect(res.model).toBe("m");
  });

  it("throws LLMUnreachableError on a non-ok response (so recall fails open)", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as unknown as Response) as typeof fetch;
    const client = new OpenAIEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    await expect(client.embed("x", "document")).rejects.toBeInstanceOf(LLMUnreachableError);
  });

  it("rewriteForRecall throws LLMUnreachableError (embedder does not rewrite; recall fails open)", async () => {
    const { fetchImpl } = recordingFetch([1]);
    const client = new OpenAIEmbedderClient({ baseUrl: "http://h:1234/v1", model: "m", fetchImpl });
    await expect(client.rewriteForRecall("q")).rejects.toBeInstanceOf(LLMUnreachableError);
  });
});
