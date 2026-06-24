// tests/integration/workstream-migration.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("migration 025 — workstreams", () => {
  it("creates workstream tables and session binding columns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-ws-mig-"));
    const storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    const db = storage.sessions.rawDb();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain("workstreams");
    expect(tables).toContain("workstream_entities");

    const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((r: any) => r.name);
    expect(sessionCols).toContain("workstream_id");
    expect(sessionCols).toContain("binding_source");
    expect(sessionCols).toContain("binding_confidence");

    // idempotent: a second init applies nothing new
    await storage.init();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
