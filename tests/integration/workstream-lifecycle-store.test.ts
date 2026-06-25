// tests/integration/workstream-lifecycle-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wslc-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("WorkstreamStore.setLabel / setStatus", () => {
  it("renames a workstream and bumps updated_at", async () => {
    const ws = await storage.workstreams.create({ id: "ws_1", label: "Old Name" });
    await storage.workstreams.setLabel("ws_1", "New Name");
    const after = await storage.workstreams.getById("ws_1");
    expect(after!.label).toBe("New Name");
    expect(after!.updatedAt >= ws.updatedAt).toBe(true);
  });
  it("retires a workstream by setting status", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Dead" });
    await storage.workstreams.setStatus("ws_1", "retired");
    expect((await storage.workstreams.getById("ws_1"))!.status).toBe("retired");
  });
});
