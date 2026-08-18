/**
 * citeSessionHandler unit tests. Exercises the MCP tool handler directly
 * without a transport or store dependency — appendCitation writes to a tmp
 * file so we can verify the entry was written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citeSessionHandler } from "../../../src/mcp/server.js";

describe("citeSessionHandler", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-session-"));
    // Redirect every path the handler writes to or reads from. Without this
    // the handler appends to the operator's real ~/.nlm/citation-log.jsonl and
    // resolves against their real transcripts.
    process.env["NLM_CITATION_LOG"] = join(tmp, "citation-log.jsonl");
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_CLAUDE_PROJECTS_ROOT"] = join(tmp, "projects");
  });

  afterEach(() => {
    delete process.env["NLM_CITATION_LOG"];
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_CLAUDE_PROJECTS_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("echoes the id and reports it was not logged when unattributable", async () => {
    const result = await citeSessionHandler("team_local", { id: "cc_sub_abc123def456" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["logged"]).toBe(false);
    expect(parsed["id"]).toBe("cc_sub_abc123def456");
  });

  it("returns an error for an id that is too short", async () => {
    const result = await citeSessionHandler("team_local", { id: "short" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error");
  });

  it("returns an error for an empty id", async () => {
    const result = await citeSessionHandler("team_local", { id: "" });
    expect(result.isError).toBe(true);
  });

  it("accepts optional conversation_id and reason without error", async () => {
    const result = await citeSessionHandler("team_local", {
      id: "cc_sub_abc123def456",
      conversation_id: "conv_test_001",
      reason: "Used to confirm FTS5 choice.",
    });
    expect(result.isError).toBeFalsy();
  });
});
