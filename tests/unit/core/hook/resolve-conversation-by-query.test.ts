/**
 * Unit tests for resolveConversationByQuery.
 * Uses a temp fake projects tree; never touches ~/.claude.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConversationByQuery } from "../../../../src/core/hook/resolve-conversation-by-query.js";

describe("resolveConversationByQuery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-resolve-conv-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null for a missing rootDir", () => {
    const result = resolveConversationByQuery("what did we decide about pgvector", {
      rootDir: join(tmp, "nonexistent"),
    });
    expect(result).toBeNull();
  });

  it("returns null for a query below the minimum length floor", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "conv-abc.jsonl"), JSON.stringify({ query: "pgvect" }) + "\n");
    const result = resolveConversationByQuery("pgvect", { rootDir: tmp });
    expect(result).toBeNull();
  });

  it("returns null when no transcript contains the query", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "conv-abc.jsonl"), JSON.stringify({ query: "something else entirely" }) + "\n");
    const result = resolveConversationByQuery("pgvector FTS5 benchmark", { rootDir: tmp });
    expect(result).toBeNull();
  });

  it("returns the stem of the file containing the query", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "conv-abc123.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "recall_sessions", input: { query: "pgvector FTS5 benchmark" } }] } }) + "\n",
    );
    const result = resolveConversationByQuery("pgvector FTS5 benchmark", { rootDir: tmp });
    expect(result).toBe("conv-abc123");
  });

  it("returns the newest-mtime file when multiple contain the query", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });

    const older = join(projDir, "conv-old.jsonl");
    const newer = join(projDir, "conv-new.jsonl");
    const query = "hono routing middleware performance";

    writeFileSync(older, JSON.stringify({ query }) + "\n");
    writeFileSync(newer, JSON.stringify({ query }) + "\n");

    // Force mtime ordering: newer file gets a future timestamp
    const now = Date.now() / 1000;
    utimesSync(older, now - 60, now - 60);
    utimesSync(newer, now + 60, now + 60);

    const result = resolveConversationByQuery(query, { rootDir: tmp });
    expect(result).toBe("conv-new");
  });

  it("scans across subdirectories", () => {
    const sub = join(tmp, "proj-b", "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "conv-deep.jsonl"), '{"query":"embed deadline configuration"}\n');
    const result = resolveConversationByQuery("embed deadline configuration", { rootDir: tmp });
    expect(result).toBe("conv-deep");
  });

  it("caps candidates at 5 newest files and skips older ones", () => {
    const projDir = join(tmp, "proj-a");
    mkdirSync(projDir, { recursive: true });

    const query = "openai embedder timeout setting";
    const now = Date.now() / 1000;

    // Create 6 files; the oldest (conv-old6) contains the query but won't be checked
    for (let i = 1; i <= 6; i++) {
      const path = join(projDir, `conv-f${i}.jsonl`);
      writeFileSync(path, i === 6 ? JSON.stringify({ query }) + "\n" : '{"other":"data"}\n');
      // File 6 is the oldest; files 1-5 are progressively newer
      utimesSync(path, now - i * 10, now - i * 10);
    }

    // Only the 5 newest (conv-f1..f5) are scanned; conv-f6 is skipped
    const result = resolveConversationByQuery(query, { rootDir: tmp });
    expect(result).toBeNull();
  });
});

describe("resolveConversationByQuery across runtimes", () => {
  let home: string;
  const saved = { HOME: process.env["HOME"], XDG: process.env["XDG_DATA_HOME"], CC: process.env["NLM_CLAUDE_PROJECTS_ROOT"] };
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nlm-resolve-rt-"));
    process.env["HOME"] = home;
    delete process.env["XDG_DATA_HOME"];
    delete process.env["NLM_CLAUDE_PROJECTS_ROOT"];
  });

  afterEach(() => {
    restore("HOME", saved.HOME);
    restore("XDG_DATA_HOME", saved.XDG);
    restore("NLM_CLAUDE_PROJECTS_ROOT", saved.CC);
    rmSync(home, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const full = join(home, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };

  it("attributes a Muse transcript to muse:<session dir>", () => {
    write(".local/share/muse/sessions/2026/09/29/01a0-muse-conv/session.jsonl", '{"cite":"cc_cited-session-0001"}\n');
    expect(resolveConversationByQuery("cc_cited-session-0001")).toBe("muse:01a0-muse-conv");
  });

  it("attributes Codex and pi transcripts with their runtime prefix", () => {
    write(".codex/sessions/2026/09/29/rollout-abc.jsonl", '{"q":"codex query string here"}\n');
    write(".pi/agent/sessions/proj/2026-09-29_xyz.jsonl", '{"q":"pi query string here"}\n');
    expect(resolveConversationByQuery("codex query string here")).toBe("codex:rollout-abc");
    expect(resolveConversationByQuery("pi query string here")).toBe("pi:2026-09-29_xyz");
  });

  it("keeps Claude Code conversations as bare ids", () => {
    write(".claude/projects/-proj/9f1c-claude-conv.jsonl", '{"q":"claude code query string"}\n');
    expect(resolveConversationByQuery("claude code query string")).toBe("9f1c-claude-conv");
  });
});
