import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCitation,
  isAttributableConversationId,
} from "../../../../src/core/recall/citation-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

describe("isAttributableConversationId", () => {
  it("accepts real conversation ids (UUIDs)", () => {
    expect(isAttributableConversationId("4cf4b47c-8a3b-4c1f-af3b-ad6a012301ed")).toBe(true);
  });
  it("rejects fixtures, placeholders, and empties", () => {
    expect(isAttributableConversationId("conv_test_001")).toBe(false);
    expect(isAttributableConversationId("mcp_tool")).toBe(false);
    expect(isAttributableConversationId("unknown")).toBe(false);
    expect(isAttributableConversationId("")).toBe(false);
    expect(isAttributableConversationId("test_run_5")).toBe(false);
  });
});

describe("appendCitation guard", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-cite-"));
    log = join(dir, "citation-log.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes an attributable citation", async () => {
    await appendCitation(DEFAULT_TEAM_ID, { conversationId: "4cf4b47c-8a3b-4c1f-af3b-ad6a012301ed", citedId: "cc_x", kind: "tool_use" }, log);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).cited_id).toBe("cc_x");
  });

  it("drops a fixture/unattributable citation (no file written)", async () => {
    await appendCitation(DEFAULT_TEAM_ID, { conversationId: "conv_test_001", citedId: "cc_x", kind: "tool_use" }, log);
    await appendCitation(DEFAULT_TEAM_ID, { conversationId: "mcp_tool", citedId: "cc_y", kind: "tool_use" }, log);
    expect(existsSync(log)).toBe(false);
  });
});

describe("appendCitation tenant path contract", () => {
  const UUID_A = "4cf4b47c-8a3b-4c1f-af3b-ad6a012301ed";
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "nlm-cite-tenant-"));
    // NLM_STATE_ROOT keeps the non-default-tenant branch under this temp dir
    // instead of the real ~/.nlm/tenants/<t>/ (see tenant-state-path.ts).
    process.env["NLM_STATE_ROOT"] = stateRoot;
  });

  afterEach(() => {
    delete process.env["NLM_CITATION_LOG"];
    delete process.env["NLM_STATE_ROOT"];
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("default team honors NLM_CITATION_LOG override (legacy behavior)", async () => {
    const logPath = join(stateRoot, "citation-log.jsonl");
    process.env["NLM_CITATION_LOG"] = logPath;
    await appendCitation(DEFAULT_TEAM_ID, { conversationId: UUID_A, citedId: "cc_x", kind: "tool_use" });
    expect(existsSync(logPath)).toBe(true);
  });

  it("a non-default tenant writes under STATE_ROOT/tenants/<t>/citation-log.jsonl, ignoring NLM_CITATION_LOG", async () => {
    const logPath = join(stateRoot, "citation-log-legacy.jsonl");
    process.env["NLM_CITATION_LOG"] = logPath;
    const derived = join(stateRoot, "tenants", "acme-citelog-test", "citation-log.jsonl");
    await appendCitation("acme-citelog-test", { conversationId: UUID_A, citedId: "cc_x", kind: "tool_use" });
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(derived)).toBe(true);
  });

  it("two tenants' citation logs don't collide", async () => {
    const derivedA = join(stateRoot, "tenants", "tenant-a-citelog", "citation-log.jsonl");
    const derivedB = join(stateRoot, "tenants", "tenant-b-citelog", "citation-log.jsonl");
    await appendCitation("tenant-a-citelog", { conversationId: UUID_A, citedId: "cc_a", kind: "tool_use" });
    await appendCitation("tenant-b-citelog", { conversationId: UUID_A, citedId: "cc_b", kind: "tool_use" });
    const a = JSON.parse(readFileSync(derivedA, "utf8").trim());
    const b = JSON.parse(readFileSync(derivedB, "utf8").trim());
    expect(a.cited_id).toBe("cc_a");
    expect(b.cited_id).toBe("cc_b");
  });
});
