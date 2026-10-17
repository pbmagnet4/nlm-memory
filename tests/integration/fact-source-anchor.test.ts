import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runMigrations } from "../../src/core/storage/migrate.js";
import { runSourceAnchorContract } from "../contract/source-anchor.contract.js";
let tmp: string;
const migrationsDir = resolve("migrations");
runSourceAnchorContract({
  wiki: true,
  async setup() { tmp = mkdtempSync(join(tmpdir(), "nlm-anchors-")); const storage = SqliteStorage.create({ dbPath: join(tmp, "db.sqlite"), migrationsDir }); await storage.init(); return storage; },
  async close(s) { await s.close(); rmSync(tmp, { recursive: true, force: true }); },
  async sql(s, sql, params = []) { const stmt = (s as SqliteStorage).rawDb().prepare(sql); return stmt.reader ? stmt.all(...params) as Record<string, unknown>[] : (stmt.run(...params), []); },
  async ingest(s, record, facts) { const storage = s as SqliteStorage; await storage.sessions.insertSession("team_local", record, null, null, facts ? { factStore: storage.facts, facts } : null); },
  async maintain(s, facts) { const storage = s as SqliteStorage; await storage.sessions.insertFactsForSession("team_local", "anchor-session", storage.facts, facts); },
  async migrate(s) { return [...runMigrations((s as SqliteStorage).rawDb(), migrationsDir)]; },
});
