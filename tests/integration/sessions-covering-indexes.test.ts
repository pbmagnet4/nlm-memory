import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

// Whole-corpus session reads must not touch the main table: its rows carry the
// transcript body, and walking every body froze the daemon's event loop (040).
describe("sessions covering indexes", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cover-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const plan = (sql: string): string =>
    storage.sessions.rawDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all("x").map((r) => (r as { detail: string }).detail).join(" | ");

  it("serves the dataset session projection from an index", () => {
    expect(plan(`SELECT id, started_at, ended_at, duration_min, label, summary, status, transcript_path, runtime
      FROM sessions WHERE tenant_id = ? ORDER BY started_at ASC`)).toMatch(/USING COVERING INDEX idx_sessions_dataset/);
  });

  it("serves the session status integrity checks from an index", () => {
    expect(plan(`SELECT s.id FROM sessions s WHERE s.status = ? AND NOT EXISTS (
      SELECT 1 FROM session_edges e WHERE e.to_session = s.id AND e.kind = 'supersedes')`)).toMatch(/USING COVERING INDEX idx_sessions_status_id/);
  });
});
