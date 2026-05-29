/**
 * AiderAdapter unit tests.
 *
 * Each test writes a .aider.chat.history.md to a temp file, then runs
 * the adapter against it — same pattern as hermes-agent.test.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiderAdapter } from "../../../../src/core/adapters/aider.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmp: string;
let historyFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-aider-"));
  historyFile = join(tmp, ".aider.chat.history.md");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeHistory(content: string): void {
  writeFileSync(historyFile, content, "utf-8");
}

function session(ts: string, turns: { user: string; assistant?: string }[]): string {
  const lines = [`# aider chat started at ${ts}`, ""];
  for (const t of turns) {
    lines.push(`#### ${t.user}`, "");
    if (t.assistant) lines.push(t.assistant, "");
  }
  return lines.join("\n");
}

// ── detect() ─────────────────────────────────────────────────────────────────

describe("AiderAdapter.detect", () => {
  it("returns enabled=true when history file exists", () => {
    writeHistory("");
    const adapter = new AiderAdapter({ historyFile });
    expect(adapter.detect().enabled).toBe(true);
    expect(adapter.detect().path).toBe(historyFile);
  });

  it("returns enabled=false when history file is absent", () => {
    const adapter = new AiderAdapter({ historyFile: join(tmp, "missing.md") });
    expect(adapter.detect().enabled).toBe(false);
    expect(adapter.detect().path).toBeNull();
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("AiderAdapter.discover", () => {
  it("returns session IDs in file order", async () => {
    writeHistory(
      session("2024-05-01 10:00:00", [{ user: "hello", assistant: "hi" }]) +
      session("2024-05-02 11:00:00", [{ user: "world", assistant: "ok" }]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const ids = await adapter.discover();
    expect(ids).toEqual(["ai_20240501_100000", "ai_20240502_110000"]);
  });

  it("respects the since option", async () => {
    writeHistory(
      session("2024-05-01 10:00:00", [{ user: "old", assistant: "response" }]) +
      session("2024-05-10 12:00:00", [{ user: "new", assistant: "response" }]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const ids = await adapter.discover({ since: new Date("2024-05-05T00:00:00Z") });
    expect(ids).toContain("ai_20240510_120000");
    expect(ids).not.toContain("ai_20240501_100000");
  });

  it("returns empty array when file is absent", async () => {
    const adapter = new AiderAdapter({ historyFile: join(tmp, "no.md") });
    expect(await adapter.discover()).toEqual([]);
  });

  it("returns empty array for a file with no session headers", async () => {
    writeHistory("just some text without any headers\n");
    const adapter = new AiderAdapter({ historyFile });
    expect(await adapter.discover()).toEqual([]);
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("AiderAdapter.parseSession", () => {
  it("returns null for unknown session ID", async () => {
    writeHistory(session("2024-05-01 10:00:00", [{ user: "hi", assistant: "hello" }]));
    const adapter = new AiderAdapter({ historyFile });
    expect(await adapter.parseSession("ai_nonexistent")).toBeNull();
  });

  it("returns null for absent file", async () => {
    const adapter = new AiderAdapter({ historyFile: join(tmp, "absent.md") });
    expect(await adapter.parseSession("ai_20240501_100000")).toBeNull();
  });

  it("returns null when session has no turns", async () => {
    // A session header with nothing after it
    writeHistory("# aider chat started at 2024-05-01 10:00:00\n\n");
    const adapter = new AiderAdapter({ historyFile });
    expect(await adapter.parseSession("ai_20240501_100000")).toBeNull();
  });

  it("builds correct turn count and roles", async () => {
    writeHistory(
      session("2024-06-01 09:00:00", [
        { user: "what is 2+2", assistant: "It is 4." },
        { user: "and 3+3?", assistant: "That is 6." },
      ]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(4); // 2 user + 2 assistant
    expect(chunk!.runtime).toBe("aider/1.0");
  });

  it("uses first user message as label", async () => {
    writeHistory(
      session("2024-06-01 09:00:00", [
        { user: "implement the login page", assistant: "Sure, here is the code." },
      ]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.label).toBe("implement the login page");
  });

  it("truncates label to 80 chars", async () => {
    const longMsg = "a".repeat(100);
    writeHistory(session("2024-06-01 09:00:00", [{ user: longMsg, assistant: "ok" }]));
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.label.length).toBeLessThanOrEqual(80);
  });

  it("sets sourcePath to historyFile::rawTimestamp", async () => {
    writeHistory(session("2024-06-01 09:00:00", [{ user: "hi", assistant: "hello" }]));
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.sourcePath).toBe(`${historyFile}::2024-06-01 09:00:00`);
  });

  it("timestamps are ISO strings", async () => {
    writeHistory(session("2024-06-01 09:00:00", [{ user: "hi", assistant: "hello" }]));
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.startedAt).toMatch(/T/);
    expect(chunk!.endedAt).toMatch(/T/);
  });

  it("endedAt uses next session startedAt when available", async () => {
    writeHistory(
      session("2024-06-01 09:00:00", [{ user: "first", assistant: "response" }]) +
      session("2024-06-01 10:00:00", [{ user: "second", assistant: "response" }]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.endedAt).toBe(new Date("2024-06-01T10:00:00").toISOString());
  });

  it("endedAt equals startedAt when it is the last session", async () => {
    writeHistory(session("2024-06-01 09:00:00", [{ user: "only", assistant: "session" }]));
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.endedAt).toBe(chunk!.startedAt);
  });

  it("summarizes blockquote lines as [tool_action: ...]", async () => {
    writeHistory(
      `# aider chat started at 2024-06-01 09:00:00\n\n` +
      `#### add a test file\n\n` +
      `Sure, I will create it.\n\n` +
      `> Added tests/test_main.py to the chat\n\n`,
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.text).toContain("[tool_action: Added tests/test_main.py to the chat]");
  });

  it("correctly returns the right session when multiple sessions exist", async () => {
    writeHistory(
      session("2024-06-01 09:00:00", [{ user: "session one", assistant: "resp one" }]) +
      session("2024-06-02 10:00:00", [{ user: "session two", assistant: "resp two" }]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240602_100000");
    expect(chunk!.label).toBe("session two");
    expect(chunk!.id).toBe("ai_20240602_100000");
  });

  it("includes assistant response text in chunk.text", async () => {
    writeHistory(
      session("2024-06-01 09:00:00", [{ user: "what is 2+2", assistant: "The answer is 4." }]),
    );
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk!.text).toContain("The answer is 4.");
  });

  it("user-only session (no assistant response) produces 1 turn", async () => {
    writeHistory(`# aider chat started at 2024-06-01 09:00:00\n\n#### just a question\n`);
    const adapter = new AiderAdapter({ historyFile });
    const chunk = await adapter.parseSession("ai_20240601_090000");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(1);
  });
});

// ── runtime metadata ──────────────────────────────────────────────────────────

describe("AiderAdapter metadata", () => {
  it("has the correct name, runtimeVersion, and transcriptKind", () => {
    const adapter = new AiderAdapter({ historyFile });
    expect(adapter.name).toBe("aider");
    expect(adapter.runtimeVersion).toBe("aider/1.0");
    expect(adapter.transcriptKind).toBe("aider-markdown");
  });
});
