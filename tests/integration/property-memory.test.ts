import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runPropertyMemoryContract } from "../contract/property-memory.contract.js";
let tmp: string;
runPropertyMemoryContract({
  async setup() { tmp = mkdtempSync(join(tmpdir(), "nlm-properties-")); return SqliteStorage.create({ dbPath: join(tmp, "db.sqlite"), migrationsDir: resolve("migrations") }); },
  async close(s) { await s.close(); rmSync(tmp, { recursive: true, force: true }); },
  async attributeSession(s, tenantId, record) { const storage = s as SqliteStorage; await storage.properties.attributeSession(tenantId, record); },
  async maintain(s, sessionId, facts, embedder) { const storage = s as SqliteStorage; await storage.sessions.insertFactsForSession("team_local", sessionId, storage.facts, facts, embedder); },
  async ingest(s, record, facts, embedder) { const storage = s as SqliteStorage; await storage.sessions.insertSession("team_local", record, embedder ?? null, null, { factStore: storage.facts, facts }); },
});
