import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "../../src/core/storage/migrate.js";
import { verifySourceAnchorUpgrade } from "../helpers/source-anchor-upgrade.js";

it("upgrades SQLite 042 without hashing or backfilling existing sources/facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nlm-anchor-db-"));
  const db = new Database(join(dir, "db.sqlite"));
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  try {
    await verifySourceAnchorUpgrade(false, async (path) => runMigrations(db, path), async (sql) => {
      const stmt = db.prepare(sql);
      if (stmt.reader) return stmt.all() as Record<string, unknown>[];
      stmt.run(); return [];
    });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
