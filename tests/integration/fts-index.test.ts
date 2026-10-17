/**
 * Verifies the sessions_fts FTS5 index is present and kept in sync with the
 * sessions table after migrations run and rows are inserted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("sessions_fts index", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteStorage["sessions"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fts-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("populates sessions_fts via triggers on insert", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "alpha", body: "beta" }));
    store.insertSessionForTest(makeSession({ id: "s2", label: "gamma", body: "delta" }));
    const db = store.rawDb();
    const fts = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions_fts").get();
    const rows = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions").get();
    expect(fts?.n).toBe(rows?.n);
    expect(fts?.n).toBe(2);
  });

  it("records the 008 fts_rebuild migration as applied", () => {
    const db = store.rawDb();
    const row = db
      .prepare<[number], { name: string }>("SELECT name FROM schema_migrations WHERE version = ?")
      .get(8);
    expect(row?.name).toBe("fts_rebuild");
  });

  it("answers a raw FTS5 MATCH query", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "pgvector plan", body: "" }));
    const db = store.rawDb();
    const hit = db
      .prepare<[string], { id: string }>(
        "SELECT s.id FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ?",
      )
      .get('"pgvector"');
    expect(hit?.id).toBe("s1");
  });
  it.each(["UPDATE", "UPSERT"])("keeps FTS sound when a legacy %s invalidates a version", async (mode) => {
    store.insertSessionForTest(makeSession({ id: "guard", label: "labelold", summary: "summaryold", body: "bodyold" }));
    const db = store.rawDb();
    if (mode === "UPDATE") db.prepare("UPDATE sessions SET body = 'bodynew' WHERE id = 'guard'").run();
    else db.prepare(`INSERT INTO sessions(id, runtime, started_at, label, summary, body, status)
      VALUES ('guard', 'test', '2026-01-01', 'labelold', 'summaryold', 'bodynew', 'closed')
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`).run();
    const hits = (word: string) => db.prepare("SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?").all(word);
    expect(hits("bodyold")).toHaveLength(0);
    expect(hits("bodynew")).toHaveLength(1);
    for (const column of ["label", "summary"] as const) {
      db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = 'guard'`).run(`${column}new`);
      expect(hits(`${column}old`)).toHaveLength(0);
      expect(hits(`${column}new`)).toHaveLength(1);
    }
    db.prepare("UPDATE sessions SET body_version = NULL WHERE id = 'guard'").run();
    expect(hits("bodynew")).toHaveLength(1);
    db.prepare("INSERT INTO sessions_fts(sessions_fts, rank) VALUES('integrity-check', 1)").run();
  });

});
