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
