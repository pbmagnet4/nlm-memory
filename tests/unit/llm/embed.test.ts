/**
 * Unit tests for OllamaClient.embed: nomic prefix scheme, L2 normalization,
 * 8K char truncation. These guard the nomic-embed-text v1.5 contract.
 */

import { describe, expect, it } from "vitest";
import { OllamaClient, l2Normalize } from "../../../src/llm/ollama-client.js";

type FakeFetch = typeof fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(reply: (req: { url: string; body: unknown }) => Response): FakeFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body.toString()) : null;
    return reply({ url, body });
  }) as FakeFetch;
}

describe("OllamaClient.embed prefix scheme", () => {
  it("prefixes a query call with 'search_query: '", async () => {
    let prompt = "";
    const fetchImpl = makeFetch(({ body }) => {
      prompt = (body as { prompt: string }).prompt;
      return jsonResponse({ embedding: [1, 0, 0] });
    });
    const client = new OllamaClient({ fetchImpl });
    await client.embed("what did we decide about pgvector", "query");
    expect(prompt.startsWith("search_query: ")).toBe(true);
    expect(prompt).toContain("pgvector");
  });

  it("prefixes a document call with 'search_document: '", async () => {
    let prompt = "";
    const fetchImpl = makeFetch(({ body }) => {
      prompt = (body as { prompt: string }).prompt;
      return jsonResponse({ embedding: [1, 0, 0] });
    });
    const client = new OllamaClient({ fetchImpl });
    await client.embed("session body text", "document");
    expect(prompt.startsWith("search_document: ")).toBe(true);
  });

  it("truncates text to 8000 chars before prefixing", async () => {
    let prompt = "";
    const fetchImpl = makeFetch(({ body }) => {
      prompt = (body as { prompt: string }).prompt;
      return jsonResponse({ embedding: [1, 0, 0] });
    });
    const client = new OllamaClient({ fetchImpl });
    const big = "x".repeat(10_000);
    await client.embed(big, "document");
    // prompt = "search_document: " + truncated → prefix is 17 chars, body capped at 8000
    expect(prompt.length).toBe(17 + 8_000);
  });

  it("L2-normalizes the returned vector", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ embedding: [3, 4, 0] }));
    const client = new OllamaClient({ fetchImpl });
    const { vector } = await client.embed("anything", "document");
    // raw norm = 5; normalized should be [0.6, 0.8, 0]
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
    expect(vector[2]).toBe(0);
    let norm = 0;
    for (const v of vector) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });
});

describe("l2Normalize", () => {
  it("returns a unit vector for a non-zero input", () => {
    const out = l2Normalize(new Float32Array([3, 4, 0]));
    let sum = 0;
    for (const v of out) sum += v * v;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 6);
  });

  it("returns the zero vector unchanged", () => {
    const zero = new Float32Array([0, 0, 0]);
    const out = l2Normalize(zero);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});
