/**
 * Path-contract tests for core/recall/recent-log.ts (M6 Task 2). This module
 * was out of scope for Task 1 (not in the plan's module list) but reads the
 * same query_log.jsonl file query-log.ts writes, and GET /api/recall/recent
 * (M6-FILTER, un-gated in this task) calls it — so it needs the same
 * tenantId-first path derivation or the un-gated route would read a shared,
 * non-tenant-scoped file. Entry parsing / tail-window behavior is untouched
 * and not re-tested here.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logQuery, type LogEntry } from "../../../../src/core/recall/query-log.js";
import { recentQueryLog } from "../../../../src/core/recall/recent-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  source: "test",
  runtime: null,
  query: "q",
  entity: null,
  kind: null,
  mode: "keyword",
  limit: 5,
  nResults: 0,
  returnedIds: [],
  ...over,
});

describe("recent-log.ts tenant path contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-recentlog-tenant-"));
    process.env["NLM_STATE_ROOT"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_QUERY_LOG"];
    delete process.env["NLM_STATE_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default team honors NLM_QUERY_LOG override (legacy behavior)", async () => {
    const logPath = join(tmp, "query_log.jsonl");
    process.env["NLM_QUERY_LOG"] = logPath;
    await logQuery(DEFAULT_TEAM_ID, entry({ query: "default-team-query" }));
    expect(existsSync(logPath)).toBe(true);
    const out = recentQueryLog(DEFAULT_TEAM_ID, 10);
    expect(out.map((e) => e.query)).toContain("default-team-query");
  });

  it("a non-default tenant reads STATE_ROOT/tenants/<t>/query_log.jsonl, ignoring NLM_QUERY_LOG", async () => {
    const logPath = join(tmp, "query_log.jsonl");
    process.env["NLM_QUERY_LOG"] = logPath;
    const derived = join(tmp, "tenants", "acme-recentlog-test", "query_log.jsonl");
    await logQuery("acme-recentlog-test", entry({ query: "tenant-query" }));
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(derived)).toBe(true);
    const out = recentQueryLog("acme-recentlog-test", 10);
    expect(out.map((e) => e.query)).toEqual(["tenant-query"]);
  });

  it("two tenants' recent-log reads don't collide", async () => {
    const derivedA = join(tmp, "tenants", "tenant-a-recentlog", "query_log.jsonl");
    const derivedB = join(tmp, "tenants", "tenant-b-recentlog", "query_log.jsonl");
    await logQuery("tenant-a-recentlog", entry({ query: "query-a" }));
    await logQuery("tenant-b-recentlog", entry({ query: "query-b" }));
    const outA = recentQueryLog("tenant-a-recentlog", 10);
    const outB = recentQueryLog("tenant-b-recentlog", 10);
    expect(outA.map((e) => e.query)).toEqual(["query-a"]);
    expect(outB.map((e) => e.query)).toEqual(["query-b"]);
  });

  it("an explicit logPath override wins regardless of tenant", async () => {
    const explicitPath = join(tmp, "explicit.jsonl");
    await logQuery("some-other-tenant", entry({ query: "explicit-path" }), explicitPath);
    const out = recentQueryLog("some-other-tenant", 10, explicitPath);
    expect(out.map((e) => e.query)).toEqual(["explicit-path"]);
  });
});
