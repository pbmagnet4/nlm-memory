/**
 * Transient read failures (EACCES, EBUSY, a locked DB) must surface from
 * parseSession as a throw, so scanOnce leaves the source unrecorded and retries
 * it next pass. They must never come back as null or an empty transcript, which
 * ingest records as done. A genuinely empty or malformed source stays null.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiderAdapter } from "../../src/core/adapters/aider.js";
import { CursorAdapter } from "../../src/core/adapters/cursor.js";
import { WindsurfAdapter } from "../../src/core/adapters/windsurf.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-adapter-transient-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";

function makeDb(path: string, ddl: string, rows: Array<[string, string]>): void {
  const db = new Database(path);
  db.exec(ddl);
  const table = ddl.includes("cursorDiskKV") ? "cursorDiskKV" : "ItemTable";
  for (const [k, v] of rows) db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`).run(k, v);
  db.close();
}

const ITEM_DDL = "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)";
const KV_DDL = "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)";
const tab = { tabId: "t1", bubbles: [{ type: "user", text: "hi" }, { type: "ai", text: "hello" }] };

describe("aider", () => {
  it("rejects when the history file cannot be read, instead of returning null", async () => {
    const historyFile = join(tmp, "history.md");
    writeFileSync(
      historyFile,
      "# aider chat started at 2026-10-01 10:00:00\n\n#### hello\n\nhi there\n",
    );
    const adapter = new AiderAdapter({ historyFile });
    const [id] = await adapter.discover();
    expect((await adapter.parseSession(id!))?.turnCount).toBe(2);

    chmodSync(historyFile, 0o000);
    await expect(adapter.parseSession(id!)).rejects.toThrow();
    chmodSync(historyFile, 0o644);
  });

  it("a readable history with no turns is still null", async () => {
    const historyFile = join(tmp, "history.md");
    writeFileSync(historyFile, "# aider chat started at 2026-10-01 10:00:00\n\n");
    const adapter = new AiderAdapter({ historyFile });
    const [id] = await adapter.discover();
    expect(await adapter.parseSession(id!)).toBeNull();
  });
});

describe("windsurf", () => {
  function workspaceDb(rows: Array<[string, string]>): string {
    const dir = join(tmp, "User", "workspaceStorage", "ws1");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state.vscdb");
    makeDb(dbPath, ITEM_DDL, rows);
    return dbPath;
  }

  it("rejects a workspace tab whose DB cannot be opened, instead of returning null", async () => {
    const dbPath = workspaceDb([[CHAT_KEY, JSON.stringify({ tabs: [tab] })]]);
    const adapter = new WindsurfAdapter({ userDir: join(tmp, "User") });
    expect((await adapter.parseSession("ws_t1"))?.turnCount).toBe(2);

    chmodSync(dbPath, 0o000);
    await expect(adapter.parseSession("ws_t1")).rejects.toThrow();
    chmodSync(dbPath, 0o644);
  });

  it("rejects a global session whose DB cannot be opened", async () => {
    const dir = join(tmp, "User", "globalStorage");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state.vscdb");
    makeDb(dbPath, KV_DDL, [
      ["composerData:g1", JSON.stringify({ composerId: "g1", conversation: [{ type: 1, text: "q" }, { type: 2, text: "a" }] })],
    ]);
    const adapter = new WindsurfAdapter({ userDir: join(tmp, "User") });
    expect((await adapter.parseSession("wsg_g1"))?.turnCount).toBe(2);

    chmodSync(dbPath, 0o000);
    await expect(adapter.parseSession("wsg_g1")).rejects.toThrow();
    chmodSync(dbPath, 0o644);
  });

  it("skips a workspace DB without ItemTable and still reads the tab from a later DB", async () => {
    const dir0 = join(tmp, "User", "workspaceStorage", "ws0");
    mkdirSync(dir0, { recursive: true });
    makeDb(join(dir0, "state.vscdb"), "CREATE TABLE other (x TEXT)", []);
    workspaceDb([[CHAT_KEY, JSON.stringify({ tabs: [tab] })]]);
    const adapter = new WindsurfAdapter({ userDir: join(tmp, "User") });
    expect((await adapter.parseSession("ws_t1"))?.turnCount).toBe(2);
  });

  it("malformed chat JSON is still a null session", async () => {
    workspaceDb([[CHAT_KEY, "{not json"]]);
    const adapter = new WindsurfAdapter({ userDir: join(tmp, "User") });
    expect(await adapter.parseSession("ws_t1")).toBeNull();
  });
});

describe("cursor", () => {
  const globalPath = () => join(tmp, "User", "globalStorage", "state.vscdb");
  function workspaceDb(rows: Array<[string, string]>): string {
    const dir = join(tmp, "User", "workspaceStorage", "ws1");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state.vscdb");
    makeDb(dbPath, ITEM_DDL, rows);
    return dbPath;
  }
  const adapter = () => new CursorAdapter({ dbPath: globalPath() });

  it("rejects a workspace chat tab whose DB cannot be opened, instead of returning null", async () => {
    mkdirSync(join(tmp, "User", "globalStorage"), { recursive: true });
    const dbPath = workspaceDb([[CHAT_KEY, JSON.stringify({ tabs: [tab] })]]);
    expect((await adapter().parseSession("crc_t1"))?.turnCount).toBe(2);

    chmodSync(dbPath, 0o000);
    await expect(adapter().parseSession("crc_t1")).rejects.toThrow();
    chmodSync(dbPath, 0o644);
  });

  it("rejects a workspace composer whose DB cannot be opened", async () => {
    mkdirSync(join(tmp, "User", "globalStorage"), { recursive: true });
    const composers = { allComposers: [{ composerId: "c1", conversation: [{ type: 1, text: "q" }, { type: 2, text: "a" }] }] };
    const dbPath = workspaceDb([["composer.composerData", JSON.stringify(composers)]]);
    expect((await adapter().parseSession("crw_c1"))?.turnCount).toBe(2);

    chmodSync(dbPath, 0o000);
    await expect(adapter().parseSession("crw_c1")).rejects.toThrow();
    chmodSync(dbPath, 0o644);
  });

  it("rejects a global composer whose DB cannot be opened", async () => {
    mkdirSync(join(tmp, "User", "globalStorage"), { recursive: true });
    makeDb(globalPath(), KV_DDL, [
      ["composerData:c1", JSON.stringify({ composerId: "c1", conversation: [{ type: 1, text: "q" }, { type: 2, text: "a" }] })],
    ]);
    expect((await adapter().parseSession("cr_c1"))?.turnCount).toBe(2);

    chmodSync(globalPath(), 0o000);
    await expect(adapter().parseSession("cr_c1")).rejects.toThrow();
    chmodSync(globalPath(), 0o644);
  });

  it("malformed workspace JSON is still a null session, and a workspace DB without ItemTable is skipped", async () => {
    mkdirSync(join(tmp, "User", "globalStorage"), { recursive: true });
    const bare = join(tmp, "User", "workspaceStorage", "ws0");
    mkdirSync(bare, { recursive: true });
    makeDb(join(bare, "state.vscdb"), "CREATE TABLE other (x TEXT)", []);
    workspaceDb([[CHAT_KEY, "{not json"]]);
    expect(await adapter().parseSession("crc_t1")).toBeNull();
  });
});
