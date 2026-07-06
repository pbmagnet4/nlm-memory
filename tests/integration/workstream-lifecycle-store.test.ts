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
    const ws = await storage.workstreams.create({ id: "ws_1", label: "Old Name", scope: null });
    await storage.workstreams.setLabel("ws_1", "New Name");
    const after = await storage.workstreams.getById("ws_1");
    expect(after!.label).toBe("New Name");
    expect(after!.updatedAt >= ws.updatedAt).toBe(true);
  });
  it("retires a workstream by setting status", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Dead", scope: null });
    await storage.workstreams.setStatus("ws_1", "retired");
    expect((await storage.workstreams.getById("ws_1"))!.status).toBe("retired");
  });
});

describe("WorkstreamStore.merge", () => {
  it("points from->into, marks merged, and unions entities", async () => {
    // workstream_entities.entity_canonical FK-references entities(canonical); seed them first.
    const db = storage.sessions.rawDb();
    for (const name of ["alpha", "shared", "beta"]) {
      db.prepare("INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')").run(name);
    }
    await storage.workstreams.create({ id: "ws_from", label: "Dup", scope: null });
    await storage.workstreams.create({ id: "ws_into", label: "Keep", scope: null });
    await storage.workstreams.upsertEntities("ws_from", ["alpha", "shared"]);
    await storage.workstreams.upsertEntities("ws_into", ["shared", "beta"]);

    await storage.workstreams.merge("ws_from", "ws_into");

    const from = await storage.workstreams.getById("ws_from");
    expect(from!.mergedInto).toBe("ws_into");
    expect(from!.status).toBe("merged");

    const ents = await storage.workstreams.entitiesFor(["ws_into", "ws_from"]);
    const into = (ents.get("ws_into") ?? []).sort();
    expect(into).toEqual(["alpha", "beta", "shared"]); // union, deduped by PK
    expect(ents.get("ws_from") ?? []).toEqual([]);     // from's entity rows cleared

    // The non-obvious UPSERT branch: the shared entity's session_count must SUM (from 1 + into 1 = 2),
    // not overwrite. entitiesFor returns names only, so assert the count directly via the raw db.
    const sharedCount = storage.sessions.rawDb()
      .prepare("SELECT session_count FROM workstream_entities WHERE workstream_id = ? AND entity_canonical = ?")
      .get("ws_into", "shared") as { session_count: number };
    expect(sharedCount.session_count).toBe(2);
  });
});
