import { describe, it, expect } from "vitest";
import { askClef, askClefOrNull } from "../../../src/llm/clef-client.js";

const ok = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

describe("clef client", () => {
  it("posts state and questions with bearer auth and returns answers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as typeof fetch;
    const r = await askClef({ text: "hi" }, { q: { type: "noul", instructions: "Is it?" } },
      { baseUrl: "http://gw:4000", apiKey: "k", fetchImpl });
    expect(seen?.url).toBe("http://gw:4000/clef/v1/systemone");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(seen?.init.body as string);
    expect(body.model).toBe("clef-oQ4e");
    expect(body.state).toEqual({ text: "hi" });
    expect(r.answers.q).toEqual({ type: "noul", noul: 0.9 });
  });

  it("throws on HTTP error and askClefOrNull fails open", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const args = [{}, { q: { type: "noul", instructions: "x" } }, { baseUrl: "http://gw", apiKey: "k", fetchImpl }] as const;
    await expect(askClef(...args)).rejects.toThrow(/500/);
    expect(await askClefOrNull(...args)).toBeNull();
  });

  it("treats a reply without answers as an error", async () => {
    const args = [{}, { q: { type: "noul", instructions: "x" } },
      { baseUrl: "http://gw", apiKey: "k", fetchImpl: ok({ model: "m" }) }] as const;
    expect(await askClefOrNull(...args)).toBeNull();
  });
});
