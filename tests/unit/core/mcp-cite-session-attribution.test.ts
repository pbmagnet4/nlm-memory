// tests/unit/core/mcp-cite-session-attribution.test.ts
//
// Regression: cite_session resolved a conversation id only from the hook's
// surfaced-memo. When the recall hook injects nothing the memo is empty, so
// every call fell back to "mcp_tool", which appendCitation drops as
// unattributable -- while the handler still answered {logged: true}. The
// documented "call cite_session after using a recalled session" workflow
// therefore wrote nothing, silently, for two months.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { citeSessionHandler } from "../../../src/mcp/server.js";

const SESSION_ID = "cc_sub_a5894f161bd2d251b";

describe("cite_session conversation attribution", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-attr-"));
    logPath = join(tmp, "citation-log.jsonl");
    process.env["NLM_CITATION_LOG"] = logPath;
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_CLAUDE_PROJECTS_ROOT"] = join(tmp, "projects");
  });

  afterEach(() => {
    delete process.env["NLM_CITATION_LOG"];
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_CLAUDE_PROJECTS_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(conversationId: string, contents: string): void {
    const dir = join(tmp, "projects", "some-project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${conversationId}.jsonl`), contents, "utf8");
  }

  it("attributes the citation to the conversation whose transcript names the cited id", async () => {
    const conversationId = "11111111-2222-3333-4444-555555555555";
    writeTranscript(
      conversationId,
      `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"cite_session","input":{"id":"${SESSION_ID}"}}]}}\n`,
    );

    const result = await citeSessionHandler("team_local", { id: SESSION_ID });

    expect(result.isError).toBeFalsy();
    expect(existsSync(logPath)).toBe(true);
    const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe(conversationId);
    expect(rows[0].cited_id).toBe(SESSION_ID);
  });

  it("reports logged:false rather than claiming success when the citation is dropped", async () => {
    // No transcript, no memo -> nothing to attribute to.
    const result = await citeSessionHandler("team_local", { id: SESSION_ID });

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["logged"]).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  it("still honours an explicitly supplied conversation_id", async () => {
    const conversationId = "99999999-8888-7777-6666-555555555555";
    const result = await citeSessionHandler("team_local", {
      id: SESSION_ID,
      conversation_id: conversationId,
    });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["logged"]).toBe(true);
    const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0].conversation_id).toBe(conversationId);
  });
});
