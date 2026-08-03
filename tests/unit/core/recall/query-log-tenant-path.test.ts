/**
 * Path-contract tests for core/recall/query-log.ts (M6 Task 1). Named
 * separately from a would-be query-log.test.ts to avoid clashing with the
 * intent-classification integration coverage in query-intent.test.ts; entry
 * format / stats math are covered elsewhere (query-intent.test.ts,
 * mcp-recall-logging.test.ts). This file only exercises the new
 * tenantId-first path derivation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logQuery, type LogEntry } from "../../../../src/core/recall/query-log.js";
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

describe("query-log.ts tenant path contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-querylog-tenant-"));
    // NLM_STATE_ROOT keeps the non-default-tenant branch under this temp dir
    // instead of the real ~/.nlm/tenants/<t>/ (see tenant-state-path.ts).
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
    await logQuery(DEFAULT_TEAM_ID, entry());
    expect(existsSync(logPath)).toBe(true);
  });

  it("a non-default tenant writes under STATE_ROOT/tenants/<t>/query_log.jsonl, ignoring NLM_QUERY_LOG", async () => {
    const logPath = join(tmp, "query_log.jsonl");
    process.env["NLM_QUERY_LOG"] = logPath;
    const derived = join(tmp, "tenants", "acme-querylog-test", "query_log.jsonl");
    await logQuery("acme-querylog-test", entry());
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(derived)).toBe(true);
  });

  it("two tenants' query logs don't collide", async () => {
    const derivedA = join(tmp, "tenants", "tenant-a-querylog", "query_log.jsonl");
    const derivedB = join(tmp, "tenants", "tenant-b-querylog", "query_log.jsonl");
    await logQuery("tenant-a-querylog", entry({ query: "query-a" }));
    await logQuery("tenant-b-querylog", entry({ query: "query-b" }));
    const a = JSON.parse(readFileSync(derivedA, "utf8").trim());
    const b = JSON.parse(readFileSync(derivedB, "utf8").trim());
    expect(a.query).toBe("query-a");
    expect(b.query).toBe("query-b");
  });

  it("an explicit logPath override wins regardless of tenant", async () => {
    const explicitPath = join(tmp, "explicit.jsonl");
    await logQuery("some-other-tenant", entry({ query: "explicit-path" }), explicitPath);
    expect(existsSync(explicitPath)).toBe(true);
  });
});
