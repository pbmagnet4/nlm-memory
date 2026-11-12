import { describe, it, expect } from "vitest";
import {
  askClef,
  askClefOrNull,
  clefSettingsFromEnv,
  CLEF_MODEL_DEFAULT,
  CLEF_PATH_DEFAULT,
} from "../../../src/llm/clef-client.js";

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

  it("posts to a direct host path with no auth header", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.1 } } }), { status: 200 });
    }) as typeof fetch;
    await askClef({ p: "x" }, { q: { type: "noul", instructions: "Is it?" } },
      { baseUrl: "http://127.0.0.1:8349/", path: "/v1/systemone", fetchImpl });
    // Trailing slash on the base is trimmed; no key means no Authorization header at all.
    expect(seen?.url).toBe("http://127.0.0.1:8349/v1/systemone");
    expect(Object.keys(seen?.init.headers as Record<string, string>)).toEqual(["content-type"]);
  });

  it("accepts a path without its leading slash and an empty key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    }) as typeof fetch;
    await askClef({}, {}, { baseUrl: "http://h", path: "v1/systemone", apiKey: "", fetchImpl });
    expect(seen?.url).toBe("http://h/v1/systemone");
    expect(seen?.init.headers).toEqual({ "content-type": "application/json" });
  });

  it("keeps the gateway path and model as defaults", () => {
    expect(CLEF_PATH_DEFAULT).toBe("/clef/v1/systemone");
    expect(CLEF_MODEL_DEFAULT).toBe("clef-oQ4e");
  });
});

describe("clefSettingsFromEnv", () => {
  it("is unconfigured (null) without a base", () => {
    expect(clefSettingsFromEnv({})).toBeNull();
    expect(clefSettingsFromEnv({ NLM_CLEF_BASE_URL: "   " })).toBeNull();
  });

  it("resolves a direct oMLX base with the gateway defaults still in place", () => {
    expect(clefSettingsFromEnv({ NLM_CLEF_BASE_URL: "http://127.0.0.1:8080" })).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      path: CLEF_PATH_DEFAULT,
      model: CLEF_MODEL_DEFAULT,
    });
    // Key stays absent rather than present-and-empty, so the header is omitted.
    expect(clefSettingsFromEnv({ NLM_CLEF_BASE_URL: "http://h", NLM_CLEF_API_KEY: "  " })).not.toHaveProperty("apiKey");
  });

  it("honours explicit path, model and key", () => {
    expect(clefSettingsFromEnv({
      NLM_CLEF_BASE_URL: " http://127.0.0.1:8080 ",
      NLM_CLEF_PATH: "/v1/systemone",
      NLM_CLEF_MODEL: "clef-flash-oQ8e",
      NLM_CLEF_API_KEY: "k",
    })).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      path: "/v1/systemone",
      model: "clef-flash-oQ8e",
      apiKey: "k",
    });
  });

  it("falls back to the defaults for blank path/model overrides", () => {
    expect(clefSettingsFromEnv({ NLM_CLEF_BASE_URL: "http://h", NLM_CLEF_PATH: "", NLM_CLEF_MODEL: " " })).toEqual({
      baseUrl: "http://h",
      path: CLEF_PATH_DEFAULT,
      model: CLEF_MODEL_DEFAULT,
    });
  });
});
