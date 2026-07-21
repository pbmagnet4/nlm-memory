/**
 * reportOutcomeHandler unit tests for the MCP report_outcome tool.
 *
 * Same fakeStore pattern as tests/unit/http/signal-routes.test.ts: this tool
 * is a thin adapter over the same normalizeSignal + SignalStore.insert path
 * POST /api/signal uses, so the row shape it produces must match.
 */

import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { reportOutcomeHandler } from "../../../src/mcp/server.js";
import type { McpDeps } from "../../../src/mcp/server.js";
import { createApp } from "../../../src/http/app.js";
import type { SessionScopeReader } from "../../../src/core/signals/stamp-scope.js";
import type { SignalStore, SignalAggregationFilter } from "../../../src/ports/signal-store.js";
import type { Signal } from "../../../src/shared/types.js";

function fakeStore(): SignalStore & { rows: Signal[] } {
  const rows: Signal[] = [];
  return {
    rows,
    async insert(s) { if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async insertMany(ss) { for (const s of ss) if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async listForAggregation(_f: SignalAggregationFilter) { return rows; },
    async countSince() { return rows.length; },
    async pruneOlderThan() { return 0; },
  };
}

function makeDeps(
  signalStore?: SignalStore,
  installScope?: string,
  sessionScopeReader?: SessionScopeReader,
): McpDeps {
  return {
    recall: {} as McpDeps["recall"],
    store: {} as McpDeps["store"],
    ...(signalStore ? { signalStore } : {}),
    ...(installScope !== undefined ? { installScope } : {}),
    ...(sessionScopeReader ? { sessionScopeReader } : {}),
  };
}

describe("reportOutcomeHandler", () => {
  let store: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    store = fakeStore();
  });

  it("writes a signals row correlated to session_id", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, "install-test"), {
      session_id: "sess_abc123",
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });

    expect(result.isError).toBeFalsy();
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.sessionId).toBe("sess_abc123");
    expect(row.outcome).toBe("pass");
    expect(row.producer).toBe("mcp");
    expect(row.installScope).toBe("install-test");
    expect(row.detail).toMatchObject({ source_of_record: "ci:github-actions" });

    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(body["recorded"]).toBe(true);
    expect(body["id"]).toBe(row.id);
  });

  it("writes a signals row correlated only by correlation_key, preserving it in detail", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, "install-test"), {
      correlation_key: "n8n-run-9981",
      outcome: "fail",
      source_of_record: "n8n:deploy-workflow",
    });

    expect(result.isError).toBeFalsy();
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.sessionId).toBeNull();
    expect(row.outcome).toBe("fail");
    expect(row.detail).toMatchObject({
      correlation_key: "n8n-run-9981",
      source_of_record: "n8n:deploy-workflow",
    });
  });

  it("passes an optional detail object through alongside the contract fields", async () => {
    await reportOutcomeHandler(makeDeps(store, "install-test"), {
      session_id: "sess_def456",
      outcome: "fix",
      source_of_record: "hook:post-tool-use",
      detail: { attempt: 2, files: ["src/foo.ts"] },
    });

    const row = store.rows[0]!;
    expect(row.detail).toMatchObject({
      attempt: 2,
      files: ["src/foo.ts"],
      source_of_record: "hook:post-tool-use",
    });
  });

  it("rejects when neither session_id nor correlation_key is provided", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, "install-test"), {
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });

    expect(result.isError).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects a missing source_of_record", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, "install-test"), {
      session_id: "sess_abc123",
      outcome: "pass",
      source_of_record: "",
    });

    expect(result.isError).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects an outcome string outside pass|fail|fix|exhausted with a message listing valid values", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, "install-test"), {
      session_id: "sess_abc123",
      outcome: "bogus",
      source_of_record: "ci:github-actions",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("pass");
    expect(result.content[0]!.text).toContain("fail");
    expect(result.content[0]!.text).toContain("fix");
    expect(result.content[0]!.text).toContain("exhausted");
    expect(store.rows).toHaveLength(0);
  });

  it("returns an error when the signal store is not wired", async () => {
    const result = await reportOutcomeHandler(makeDeps(undefined, "install-test"), {
      session_id: "sess_abc123",
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("signal store");
  });

  it("returns an error when installScope is not wired", async () => {
    const result = await reportOutcomeHandler(makeDeps(store, undefined), {
      session_id: "sess_abc123",
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });

    expect(result.isError).toBe(true);
    expect(store.rows).toHaveLength(0);
  });
});

describe("reportOutcomeHandler scope parity with POST /api/signal", () => {
  const prevStampFlag = process.env["NLM_SCOPE_STAMP"];
  let store: ReturnType<typeof fakeStore>;

  const scopeReader: SessionScopeReader = {
    async getSessionScopeById(id) {
      if (id === "sess_scoped") return "project-alpha";
      if (id === "sess_global") return "global";
      return null;
    },
  };

  beforeEach(() => {
    store = fakeStore();
    process.env["NLM_SCOPE_STAMP"] = "1";
  });

  afterEach(() => {
    if (prevStampFlag === undefined) delete process.env["NLM_SCOPE_STAMP"];
    else process.env["NLM_SCOPE_STAMP"] = prevStampFlag;
  });

  it("a session-correlated tool write carries the same scope the HTTP path stamps", async () => {
    await reportOutcomeHandler(makeDeps(store, "install-test", scopeReader), {
      session_id: "sess_scoped",
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });
    expect(store.rows[0]!.scope).toBe("project-alpha");

    const httpStore = fakeStore();
    const app = createApp({
      recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
      store: {} as never,
      signalStore: httpStore,
      installScope: "install-test",
      sessionScopeReader: scopeReader,
    } as never);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({
        kind: "review", producer: "mcp", outcome: "pass",
        session: "sess_scoped", detail: { source_of_record: "ci:github-actions" },
      }),
    });
    expect(res.status).toBe(202);
    expect(httpStore.rows[0]!.scope).toBe(store.rows[0]!.scope);
  });

  it("a session with global scope stamps null, matching the HTTP path", async () => {
    await reportOutcomeHandler(makeDeps(store, "install-test", scopeReader), {
      session_id: "sess_global",
      outcome: "fail",
      source_of_record: "ci:github-actions",
    });
    expect(store.rows[0]!.scope).toBeNull();
  });

  it("leaves scope null when NLM_SCOPE_STAMP is unset", async () => {
    delete process.env["NLM_SCOPE_STAMP"];
    await reportOutcomeHandler(makeDeps(store, "install-test", scopeReader), {
      session_id: "sess_scoped",
      outcome: "pass",
      source_of_record: "ci:github-actions",
    });
    expect(store.rows[0]!.scope).toBeNull();
  });
});
