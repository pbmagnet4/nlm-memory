// tests/integration/sqlite-workstream-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wsstore-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

// Workstream_entities references entities(canonical); seed the entities first.
function seedEntities(...names: string[]) {
  const db = storage.sessions.rawDb();
  for (const n of names) {
    db.prepare("INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')").run(n);
  }
}

describe("SqliteWorkstreamStore", () => {
  it("creates and reads back a workstream", async () => {
    const ws = await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    expect(ws).toMatchObject({ id: "ws_1", label: "NLM", status: "active", mergedInto: null });
    expect(await storage.workstreams.getById("ws_1")).toMatchObject({ id: "ws_1" });
    expect(await storage.workstreams.getById("nope")).toBeNull();
  });

  it("finds by normalized label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM  Memory" });
    expect(await storage.workstreams.findByNormalizedLabel("nlm memory")).toMatchObject({ id: "ws_1" });
    expect(await storage.workstreams.findByNormalizedLabel("other")).toBeNull();
  });

  it("upserts entities with session_count and reads them back", async () => {
    seedEntities("NLM", "Daemon");
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.upsertEntities("ws_1", ["NLM", "Daemon"]);
    await storage.workstreams.upsertEntities("ws_1", ["NLM"]);
    const map = await storage.workstreams.entitiesFor(["ws_1"]);
    expect(new Set(map.get("ws_1"))).toEqual(new Set(["NLM", "Daemon"]));
    const counts = storage.sessions.rawDb()
      .prepare("SELECT session_count FROM workstream_entities WHERE workstream_id='ws_1' AND entity_canonical='NLM'")
      .get() as { session_count: number };
    expect(counts.session_count).toBe(2);
  });

  it("returns entity-overlap candidates", async () => {
    seedEntities("NLM", "Daemon", "PolySignal");
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.create({ id: "ws_2", label: "PolySignal" });
    await storage.workstreams.upsertEntities("ws_1", ["NLM", "Daemon"]);
    await storage.workstreams.upsertEntities("ws_2", ["PolySignal"]);
    const cands = await storage.workstreams.candidatesByEntityOverlap(["NLM"], 10);
    expect(cands.map((c) => c.workstreamId)).toEqual(["ws_1"]);
    expect(new Set(cands[0]!.entities)).toEqual(new Set(["NLM", "Daemon"]));
  });

  it("touchLastSession updates the timestamp", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.touchLastSession("ws_1", "2026-06-24T00:00:00Z");
    expect((await storage.workstreams.getById("ws_1"))!.lastSessionAt).toBe("2026-06-24T00:00:00Z");
  });
});
