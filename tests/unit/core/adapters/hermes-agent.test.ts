/**
 * HermesAgentAdapter unit tests.
 *
 * Each test builds an in-memory SQLite DB seeded with the minimal schema
 * NousResearch Hermes Agent uses (sessions + messages tables), writes it to a
 * temp file, then runs the adapter against it — same pattern as opencode.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesAgentAdapter } from "../../../../src/core/adapters/hermes-agent.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'cli',
      title TEXT,
      started_at REAL NOT NULL,
      ended_at REAL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    );
  `);
  return db;
}

function addSession(
  db: Database.Database,
  opts: {
    id: string;
    title?: string | null;
    startedAt?: number;
    endedAt?: number | null;
  },
): void {
  const now = Date.now() / 1000;
  db.prepare(
    `INSERT INTO sessions (id, title, started_at, ended_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.title ?? null,
    opts.startedAt ?? now - 3600,
    opts.endedAt !== undefined ? opts.endedAt : now,
  );
}

let msgCounter = 1;

function addMessage(
  db: Database.Database,
  opts: {
    sessionId: string;
    role: "user" | "assistant" | "tool" | "system";
    content?: string | null;
    toolCalls?: object[] | null;
    toolName?: string | null;
    timestamp?: number;
  },
): void {
  const now = Date.now() / 1000;
  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    opts.role,
    opts.content ?? null,
    opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    opts.toolName ?? null,
    opts.timestamp ?? now - msgCounter++ * 10,
  );
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmp: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  msgCounter = 1;
  tmp = mkdtempSync(join(tmpdir(), "nlm-ha-"));
  dbPath = join(tmp, "state.db");
  db = createDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── detect() ─────────────────────────────────────────────────────────────────

describe("HermesAgentAdapter.detect", () => {
  it("returns enabled=true when DB file exists", () => {
    const adapter = new HermesAgentAdapter({ dbPath });
    expect(adapter.detect().enabled).toBe(true);
    expect(adapter.detect().path).toBe(dbPath);
  });

  it("returns enabled=false when DB file is absent", () => {
    const adapter = new HermesAgentAdapter({ dbPath: join(tmp, "missing.db") });
    expect(adapter.detect().enabled).toBe(false);
    expect(adapter.detect().path).toBeNull();
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("HermesAgentAdapter.discover", () => {
  it("returns all session IDs ordered by started_at", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_a", startedAt: now - 7200 });
    addSession(db, { id: "sess_b", startedAt: now - 3600 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const ids = await adapter.discover();
    expect(ids).toEqual(["sess_a", "sess_b"]);
  });

  it("respects the since option using started_at", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_old", startedAt: now - 86400 });
    addSession(db, { id: "sess_new", startedAt: now - 3600 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const cutoff = new Date((now - 7200) * 1000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toContain("sess_new");
    expect(ids).not.toContain("sess_old");
  });

  it("returns empty array when DB is absent", async () => {
    db.close();
    const adapter = new HermesAgentAdapter({ dbPath: join(tmp, "no.db") });
    expect(await adapter.discover()).toEqual([]);
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("HermesAgentAdapter.parseSession", () => {
  it("returns null for an unknown session ID", async () => {
    db.close();
    const adapter = new HermesAgentAdapter({ dbPath });
    expect(await adapter.parseSession("nonexistent")).toBeNull();
  });

  it("returns null when session has no usable turns", async () => {
    addSession(db, { id: "sess_empty" });
    addMessage(db, { sessionId: "sess_empty", role: "system", content: "you are a helpful assistant" });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    expect(await adapter.parseSession("sess_empty")).toBeNull();
  });

  it("builds the correct turn count and roles", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_1", startedAt: now - 300, endedAt: now });
    addMessage(db, { sessionId: "sess_1", role: "user", content: "hello", timestamp: now - 200 });
    addMessage(db, { sessionId: "sess_1", role: "assistant", content: "hi there", timestamp: now - 100 });
    addMessage(db, { sessionId: "sess_1", role: "user", content: "follow up", timestamp: now - 50 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_1");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(3);
    expect(chunk!.runtime).toBe("hermes-agent/1.0");
  });

  it("summarizes assistant tool_calls as [tool_use: <name>]", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_2", startedAt: now - 200, endedAt: now });
    addMessage(db, { sessionId: "sess_2", role: "user", content: "run a command", timestamp: now - 100 });
    addMessage(db, {
      sessionId: "sess_2",
      role: "assistant",
      content: "sure",
      toolCalls: [{ id: "call_1", function: { name: "terminal", arguments: "{}" } }],
      timestamp: now - 50,
    });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_2");
    expect(chunk!.text).toContain("[tool_use: terminal]");
    expect(chunk!.turnCount).toBe(2);
  });

  it("summarizes tool result messages as [tool_result: <name>: ...]", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_3", startedAt: now - 300, endedAt: now });
    addMessage(db, { sessionId: "sess_3", role: "user", content: "check the dir", timestamp: now - 200 });
    addMessage(db, {
      sessionId: "sess_3",
      role: "tool",
      content: "file1.txt\nfile2.txt",
      toolName: "terminal",
      timestamp: now - 100,
    });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_3");
    expect(chunk!.text).toContain("[tool_result: terminal:");
    expect(chunk!.text).toContain("file1.txt");
  });

  it("uses the session title as label when present", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_4", title: "Debug the auth flow", startedAt: now - 200, endedAt: now });
    addMessage(db, { sessionId: "sess_4", role: "user", content: "what's wrong?", timestamp: now - 100 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_4");
    expect(chunk!.label).toBe("Debug the auth flow");
  });

  it("falls back to first user turn when title is null", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_5", title: null, startedAt: now - 200, endedAt: now });
    addMessage(db, { sessionId: "sess_5", role: "user", content: "implement the search feature", timestamp: now - 100 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_5");
    expect(chunk!.label).toBe("implement the search feature");
  });

  it("sets sourcePath to dbPath::sessionId", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_6", startedAt: now - 100, endedAt: now });
    addMessage(db, { sessionId: "sess_6", role: "user", content: "hi", timestamp: now - 50 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_6");
    expect(chunk!.sourcePath).toBe(`${dbPath}::sess_6`);
  });

  it("timestamps are ISO strings", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_7", startedAt: now - 300, endedAt: now });
    addMessage(db, { sessionId: "sess_7", role: "user", content: "hello", timestamp: now - 200 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_7");
    expect(chunk!.startedAt).toMatch(/T/);
    expect(chunk!.endedAt).toMatch(/T/);
  });

  it("returns null when DB is absent", async () => {
    db.close();
    const adapter = new HermesAgentAdapter({ dbPath: join(tmp, "absent.db") });
    expect(await adapter.parseSession("any")).toBeNull();
  });

  it("skips system messages", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_8", startedAt: now - 300, endedAt: now });
    addMessage(db, { sessionId: "sess_8", role: "system", content: "you are a helpful agent", timestamp: now - 250 });
    addMessage(db, { sessionId: "sess_8", role: "user", content: "hello", timestamp: now - 200 });
    addMessage(db, { sessionId: "sess_8", role: "assistant", content: "hi", timestamp: now - 100 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_8");
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).not.toContain("you are a helpful agent");
  });

  it("safeSessionId uses ha_ prefix with date+suffix for YYYYMMDD_HHMMSS_hex IDs", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "20260528_143022_f7c2b9", startedAt: now - 100, endedAt: now });
    addMessage(db, { sessionId: "20260528_143022_f7c2b9", role: "user", content: "hi", timestamp: now - 50 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("20260528_143022_f7c2b9");
    expect(chunk!.id).toBe("ha_20260528_f7c2b9");
  });

  it("tool result with empty content shows name only", async () => {
    const now = Date.now() / 1000;
    addSession(db, { id: "sess_9", startedAt: now - 200, endedAt: now });
    addMessage(db, { sessionId: "sess_9", role: "user", content: "go", timestamp: now - 100 });
    addMessage(db, { sessionId: "sess_9", role: "tool", content: "", toolName: "bash", timestamp: now - 50 });
    db.close();

    const adapter = new HermesAgentAdapter({ dbPath });
    const chunk = await adapter.parseSession("sess_9");
    // tool message with empty content still contributes a turn with placeholder
    // but empty content → turn text is "[tool_result: bash]" → not empty → included
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toContain("[tool_result: bash]");
  });
});

// ── runtime metadata ──────────────────────────────────────────────────────────

describe("HermesAgentAdapter metadata", () => {
  it("has the correct name, runtimeVersion, and transcriptKind", () => {
    const adapter = new HermesAgentAdapter({ dbPath });
    expect(adapter.name).toBe("hermes-agent");
    expect(adapter.runtimeVersion).toBe("hermes-agent/1.0");
    expect(adapter.transcriptKind).toBe("hermes-agent-sqlite");
  });
});
