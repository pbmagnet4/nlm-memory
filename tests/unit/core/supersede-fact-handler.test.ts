/**
 * Unit tests for supersedeFactHandler — the MCP handler for supersede_fact.
 *
 * Uses stub deps so no database or Ollama required.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supersedeFactHandler } from "../../../src/mcp/server.js";
import type { McpDeps } from "../../../src/mcp/server.js";
import type { FactStore } from "../../../src/ports/fact-store.js";

function makeStubFactStore(markSupersededImpl?: (id: string, newId: string | null) => Promise<void>): FactStore {
  return {
    insert: vi.fn(),
    insertMany: vi.fn(),
    getById: vi.fn(),
    findCurrent: vi.fn(),
    list: vi.fn(),
    listBySession: vi.fn(),
    markSuperseded: vi.fn(markSupersededImpl ?? (() => Promise.resolve())),
    upsertEmbedding: vi.fn(),
    ingestSessionFacts: vi.fn(),
    listForRecall: vi.fn(),
    semanticSearch: vi.fn(),
    getHistory: vi.fn(),
    corroborationCounts: vi.fn(),
  } as unknown as FactStore;
}

function makeDeps(factStore?: FactStore): McpDeps {
  return {
    recall: {} as McpDeps["recall"],
    store: {} as McpDeps["store"],
    factStore,
  };
}

describe("supersedeFactHandler", () => {
  let tmp: string;
  let origLogEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-supersede-fact-handler-"));
    origLogEnv = process.env["NLM_SUPERSEDENCE_LOG"];
    process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "supersedence-log.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origLogEnv === undefined) {
      delete process.env["NLM_SUPERSEDENCE_LOG"];
    } else {
      process.env["NLM_SUPERSEDENCE_LOG"] = origLogEnv;
    }
    vi.restoreAllMocks();
  });

  it("calls markSuperseded(fact_id, null) and returns marked=true", async () => {
    const factStore = makeStubFactStore();
    const result = await supersedeFactHandler(makeDeps(factStore), {
      fact_id: "fact_abc123",
      reason: "outdated decision",
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(body["marked"]).toBe(true);
    expect(body["fact_id"]).toBe("fact_abc123");
    expect(body["reason"]).toBe("outdated decision");
    expect(vi.mocked(factStore.markSuperseded)).toHaveBeenCalledWith("fact_abc123", null);
  });

  it("omits reason from response when not provided", async () => {
    const factStore = makeStubFactStore();
    const result = await supersedeFactHandler(makeDeps(factStore), { fact_id: "fact_xyz" });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect("reason" in body).toBe(false);
  });

  it("returns an error when fact_id is missing or too short", async () => {
    const factStore = makeStubFactStore();
    const result = await supersedeFactHandler(makeDeps(factStore), { fact_id: "" });

    expect(result.isError).toBe(true);
  });

  it("returns an error when factStore is absent", async () => {
    const result = await supersedeFactHandler(makeDeps(undefined), { fact_id: "fact_abc" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("fact store not available");
  });

  it("surfaces factStore errors as MCP error responses", async () => {
    const factStore = makeStubFactStore(() => Promise.reject(new Error("Fact not found")));
    const result = await supersedeFactHandler(makeDeps(factStore), { fact_id: "fact_missing" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Fact not found");
  });
});
