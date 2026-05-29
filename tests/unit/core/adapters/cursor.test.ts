/**
 * CursorAdapter unit tests.
 *
 * Each test builds an in-memory SQLite DB seeded with the cursorDiskKV
 * key-value schema Cursor uses, writes it to a temp file so the adapter
 * can open it with better-sqlite3 in readonly mode.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../../../../src/core/adapters/cursor.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursorDiskKV (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function addComposerInline(
  db: Database.Database,
  composerId: string,
  opts: {
    name?: string;
    createdAt?: string;
    lastUpdatedAt?: string;
    conversation?: Array<{ type: number; text: string }>;
  } = {},
): void {
  const data = {
    composerId,
    name: opts.name ?? "Test session",
    createdAt: opts.createdAt ?? new Date(Date.now() - 3600_000).toISOString(),
    lastUpdatedAt: opts.lastUpdatedAt ?? new Date().toISOString(),
    conversation: opts.conversation ?? [],
  };
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    `composerData:${composerId}`,
    JSON.stringify(data),
  );
}

function addBubble(
  db: Database.Database,
  composerId: string,
  bubbleId: string,
  type: 1 | 2,
  text: string,
): void {
  const data = { type, text };
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    `bubbleId:${composerId}:${bubbleId}`,
    JSON.stringify(data),
  );
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";

function createWorkspaceDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function addWorkspaceComposer(
  db: Database.Database,
  composerId: string,
  opts: { name?: string; createdAt?: string; lastUpdatedAt?: string; conversation?: Array<{ type: number; text: string }> } = {},
): void {
  const allComposers = [{ composerId, name: opts.name ?? "ws composer", createdAt: opts.createdAt, lastUpdatedAt: opts.lastUpdatedAt, conversation: opts.conversation ?? [] }];
  db.prepare(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`).run(
    "composer.composerData",
    JSON.stringify({ allComposers }),
  );
}

function addWorkspaceChatTab(
  db: Database.Database,
  tabs: Array<{ tabId: string; chatTitle?: string; lastSendTime?: number; bubbles?: Array<{ type: "user" | "ai"; text?: string }> }>,
): void {
  db.prepare(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`).run(
    CHAT_KEY,
    JSON.stringify({ tabs }),
  );
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmp: string;
let dbPath: string;
let adapter: CursorAdapter;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-cursor-"));
  // globalStorage/state.vscdb — adapter derives workspaceStorage from its parent's parent
  dbPath = join(tmp, "globalStorage", "state.vscdb");
  mkdirSync(dirname(dbPath), { recursive: true });
  adapter = new CursorAdapter({ dbPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── detect() ─────────────────────────────────────────────────────────────────

describe("detect()", () => {
  it("returns enabled when DB exists", () => {
    const db = createDb(dbPath);
    db.close();
    const result = adapter.detect();
    expect(result.enabled).toBe(true);
    expect(result.path).toBe(dbPath);
    expect(result.hint).toBeNull();
  });

  it("returns disabled when DB is absent", () => {
    const result = adapter.detect();
    expect(result.enabled).toBe(false);
    expect(result.path).toBeNull();
    expect(result.hint).toMatch(/Cursor/);
  });
});

// ── discover() ───────────────────────────────────────────────────────────────

describe("discover()", () => {
  it("returns empty array when DB is absent", async () => {
    expect(await adapter.discover()).toEqual([]);
  });

  it("returns prefixed composerIds for all composer entries", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "composer-aaa");
    addComposerInline(db, "composer-bbb");
    db.close();

    const ids = await adapter.discover();
    expect(ids).toEqual(["cr_composer-aaa", "cr_composer-bbb"]);
  });

  it("returns empty array when DB has no cursorDiskKV table", async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE ItemTable (key TEXT, value TEXT);`);
    db.close();
    expect(await adapter.discover()).toEqual([]);
  });

  it("skips entries whose value is not valid JSON", async () => {
    const db = createDb(dbPath);
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:broken",
      "not-json",
    );
    addComposerInline(db, "composer-good");
    db.close();

    const ids = await adapter.discover();
    expect(ids).toEqual(["cr_composer-good"]);
  });

  it("filters by since when lastUpdatedAt is set", async () => {
    const db = createDb(dbPath);
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const recent = new Date().toISOString();
    addComposerInline(db, "old-composer", { lastUpdatedAt: old });
    addComposerInline(db, "new-composer", { lastUpdatedAt: recent });
    db.close();

    const cutoff = new Date(Date.now() - 5 * 24 * 3600_000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toEqual(["cr_new-composer"]);
  });
});

// ── parseSession() ────────────────────────────────────────────────────────────

describe("parseSession()", () => {
  it("returns null when DB is absent", async () => {
    expect(await adapter.parseSession("any-id")).toBeNull();
  });

  it("returns null for unknown composerId", async () => {
    const db = createDb(dbPath);
    db.close();
    expect(await adapter.parseSession("ghost-id")).toBeNull();
  });

  it("returns null for composer with no turns", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "empty-id", { conversation: [] });
    db.close();
    expect(await adapter.parseSession("empty-id")).toBeNull();
  });

  it("extracts turns from inline conversation[]", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "inline-id", {
      name: "My session",
      conversation: [
        { type: 1, text: "Hello" },
        { type: 2, text: "Hi there" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("inline-id");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: Hello");
    expect(chunk!.text).toContain("assistant: Hi there");
  });

  it("falls back to bubbleId:* separate storage when conversation is empty", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "sep-id", { conversation: [] });
    addBubble(db, "sep-id", "b1", 1, "What is 2+2?");
    addBubble(db, "sep-id", "b2", 2, "It is 4.");
    db.close();

    const chunk = await adapter.parseSession("sep-id");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: What is 2+2?");
    expect(chunk!.text).toContain("assistant: It is 4.");
  });

  it("uses composer name as label", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "named-id", {
      name: "Refactor the auth module",
      conversation: [{ type: 1, text: "Let's refactor" }],
    });
    db.close();

    const chunk = await adapter.parseSession("named-id");
    expect(chunk!.label).toBe("Refactor the auth module");
  });

  it("falls back to first user turn as label when name is absent", async () => {
    const db = createDb(dbPath);
    const data = {
      composerId: "unlabeled-id",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      conversation: [
        { type: 1, text: "Tell me about TypeScript generics" },
        { type: 2, text: "Generics allow..." },
      ],
    };
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:unlabeled-id",
      JSON.stringify(data),
    );
    db.close();

    const chunk = await adapter.parseSession("unlabeled-id");
    expect(chunk!.label).toBe("Tell me about TypeScript generics");
  });

  it("sets correct id prefix and runtimeSessionId", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "id-check", {
      conversation: [{ type: 1, text: "Hello" }],
    });
    db.close();

    const chunk = await adapter.parseSession("id-check");
    expect(chunk!.runtimeSessionId).toBe("id-check");
    expect(chunk!.id).toMatch(/^cr_/);
  });

  it("sets sourcePath to dbPath::composerId", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "path-check", {
      conversation: [{ type: 1, text: "Hello" }],
    });
    db.close();

    const chunk = await adapter.parseSession("path-check");
    expect(chunk!.sourcePath).toBe(`${dbPath}::path-check`);
  });

  it("skips bubbles with empty text", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "sparse-id", {
      conversation: [
        { type: 1, text: "" },
        { type: 1, text: "Real question" },
        { type: 2, text: "Real answer" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("sparse-id");
    expect(chunk!.turnCount).toBe(2);
  });

  it("skips bubbles with unknown type", async () => {
    const db = createDb(dbPath);
    const data = {
      composerId: "typed-id",
      conversation: [
        { type: 99, text: "system message" },
        { type: 1, text: "user question" },
        { type: 2, text: "assistant answer" },
      ],
    };
    db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
      "composerData:typed-id",
      JSON.stringify(data),
    );
    db.close();

    const chunk = await adapter.parseSession("typed-id");
    expect(chunk!.turnCount).toBe(2);
  });

  it("populates byteRange[1] equal to transcript byte length", async () => {
    const db = createDb(dbPath);
    addComposerInline(db, "bytes-id", {
      conversation: [
        { type: 1, text: "Hello" },
        { type: 2, text: "Hi" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("bytes-id");
    const expected = Buffer.byteLength(chunk!.text, "utf8");
    expect(chunk!.byteRange[1]).toBe(expected);
  });
});

// ── workspace composer (crw_) ─────────────────────────────────────────────────

describe("workspace composer (crw_)", () => {
  function wsDbPath(hash = "ws-hash-1"): string {
    return join(tmp, "workspaceStorage", hash, "state.vscdb");
  }

  it("discover() returns crw_ ids from workspace ItemTable", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceComposer(db, "ws-comp-aaa", { conversation: [{ type: 1, text: "hi" }] });
    db.close();

    const ids = await adapter.discover();
    expect(ids).toContain("crw_ws-comp-aaa");
  });

  it("parseSession(crw_<id>) returns chunk from workspace composer", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceComposer(db, "ws-comp-abc", {
      name: "My workspace session",
      conversation: [
        { type: 1, text: "Fix the bug" },
        { type: 2, text: "Done!" },
      ],
    });
    db.close();

    const chunk = await adapter.parseSession("crw_ws-comp-abc");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.text).toContain("user: Fix the bug");
    expect(chunk!.text).toContain("assistant: Done!");
    expect(chunk!.label).toBe("My workspace session");
    expect(chunk!.id).toMatch(/^crw_/);
    expect(chunk!.runtimeSessionId).toBe("ws-comp-abc");
  });

  it("parseSession(crw_<id>) returns null when composer has no turns", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceComposer(db, "empty-ws-comp", { conversation: [] });
    db.close();

    expect(await adapter.parseSession("crw_empty-ws-comp")).toBeNull();
  });
});

// ── workspace chat tab (crc_) ─────────────────────────────────────────────────

describe("workspace chat tab (crc_)", () => {
  function wsDbPath(hash = "ws-chat-hash"): string {
    return join(tmp, "workspaceStorage", hash, "state.vscdb");
  }

  it("discover() returns crc_ ids from workspace chat tab ItemTable", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceChatTab(db, [
      { tabId: "chat-aaa", bubbles: [{ type: "user", text: "Hello" }] },
      { tabId: "chat-bbb", bubbles: [{ type: "ai", text: "Hi" }] },
    ]);
    db.close();

    const ids = await adapter.discover();
    expect(ids).toContain("crc_chat-aaa");
    expect(ids).toContain("crc_chat-bbb");
  });

  it("discover() skips chat tabs with no bubbles", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceChatTab(db, [
      { tabId: "empty-tab", bubbles: [] },
      { tabId: "good-tab", bubbles: [{ type: "user", text: "Hi" }] },
    ]);
    db.close();

    const ids = await adapter.discover();
    expect(ids).not.toContain("crc_empty-tab");
    expect(ids).toContain("crc_good-tab");
  });

  it("discover() filters chat tabs by since using lastSendTime", async () => {
    const db = createWorkspaceDb(wsDbPath());
    const old = Date.now() - 10 * 24 * 3600_000;
    const recent = Date.now();
    addWorkspaceChatTab(db, [
      { tabId: "old-chat", lastSendTime: old, bubbles: [{ type: "user", text: "Old" }] },
      { tabId: "new-chat", lastSendTime: recent, bubbles: [{ type: "user", text: "New" }] },
    ]);
    db.close();

    const cutoff = new Date(Date.now() - 5 * 24 * 3600_000);
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).not.toContain("crc_old-chat");
    expect(ids).toContain("crc_new-chat");
  });

  it("discover() includes chat tab with lastSendTime=0 even when since is set", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceChatTab(db, [
      { tabId: "zero-ts-chat", lastSendTime: 0, bubbles: [{ type: "user", text: "Hi" }] },
    ]);
    db.close();

    const cutoff = new Date(); // very recent cutoff
    const ids = await adapter.discover({ since: cutoff });
    expect(ids).toContain("crc_zero-ts-chat");
  });

  it("parseSession(crc_<id>) returns chunk from workspace chat tab", async () => {
    const db = createWorkspaceDb(wsDbPath());
    addWorkspaceChatTab(db, [
      {
        tabId: "crc-parse-tab",
        chatTitle: "Chat test",
        bubbles: [
          { type: "user", text: "Question" },
          { type: "ai", text: "Answer" },
        ],
      },
    ]);
    db.close();

    const chunk = await adapter.parseSession("crc_crc-parse-tab");
    expect(chunk).not.toBeNull();
    expect(chunk!.turnCount).toBe(2);
    expect(chunk!.label).toBe("Chat test");
    expect(chunk!.id).toMatch(/^crc_/);
    expect(chunk!.runtimeSessionId).toBe("crc-parse-tab");
  });
});

// ── metadata ──────────────────────────────────────────────────────────────────

describe("adapter metadata", () => {
  it("has correct name, runtimeVersion, and transcriptKind", () => {
    expect(adapter.name).toBe("cursor");
    expect(adapter.runtimeVersion).toBe("cursor/1.0");
    expect(adapter.transcriptKind).toBe("cursor-sqlite");
  });
});
