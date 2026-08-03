/**
 * Path-contract tests for core/recall-facts/fact-query-log.ts (M6 Task 1).
 * Entry format is covered by mcp-recall-logging.test.ts; this file only
 * exercises the new tenantId-first path derivation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logFactQuery, type FactLogEntry } from "../../../../src/core/recall-facts/fact-query-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

const entry = (over: Partial<FactLogEntry> = {}): FactLogEntry => ({
  source: "test",
  runtime: null,
  query: "q",
  subject: null,
  predicate: null,
  kind: null,
  mode: "keyword",
  limit: 5,
  nResults: 0,
  returnedIds: [],
  ...over,
});

describe("fact-query-log.ts tenant path contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-factquerylog-tenant-"));
    process.env["NLM_STATE_ROOT"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_FACT_QUERY_LOG"];
    delete process.env["NLM_STATE_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default team honors NLM_FACT_QUERY_LOG override (legacy behavior)", async () => {
    const logPath = join(tmp, "fact_query_log.jsonl");
    process.env["NLM_FACT_QUERY_LOG"] = logPath;
    await logFactQuery(DEFAULT_TEAM_ID, entry());
    expect(existsSync(logPath)).toBe(true);
  });

  it("a non-default tenant writes under STATE_ROOT/tenants/<t>/fact_query_log.jsonl, ignoring NLM_FACT_QUERY_LOG", async () => {
    const logPath = join(tmp, "fact_query_log.jsonl");
    process.env["NLM_FACT_QUERY_LOG"] = logPath;
    const derived = join(tmp, "tenants", "acme-factquerylog-test", "fact_query_log.jsonl");
    await logFactQuery("acme-factquerylog-test", entry());
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(derived)).toBe(true);
  });

  it("two tenants' fact query logs don't collide", async () => {
    const derivedA = join(tmp, "tenants", "tenant-a-factquerylog", "fact_query_log.jsonl");
    const derivedB = join(tmp, "tenants", "tenant-b-factquerylog", "fact_query_log.jsonl");
    await logFactQuery("tenant-a-factquerylog", entry({ query: "query-a" }));
    await logFactQuery("tenant-b-factquerylog", entry({ query: "query-b" }));
    const a = JSON.parse(readFileSync(derivedA, "utf8").trim());
    const b = JSON.parse(readFileSync(derivedB, "utf8").trim());
    expect(a.query).toBe("query-a");
    expect(b.query).toBe("query-b");
  });
});
