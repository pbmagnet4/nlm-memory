import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCitation,
  isAttributableConversationId,
} from "../../../../src/core/recall/citation-log.js";

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
    await appendCitation({ conversationId: "4cf4b47c-8a3b-4c1f-af3b-ad6a012301ed", citedId: "cc_x", kind: "tool_use" }, log);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).cited_id).toBe("cc_x");
  });

  it("drops a fixture/unattributable citation (no file written)", async () => {
    await appendCitation({ conversationId: "conv_test_001", citedId: "cc_x", kind: "tool_use" }, log);
    await appendCitation({ conversationId: "mcp_tool", citedId: "cc_y", kind: "tool_use" }, log);
    expect(existsSync(log)).toBe(false);
  });
});
