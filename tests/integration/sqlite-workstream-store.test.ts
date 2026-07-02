// tests/integration/sqlite-workstream-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import {
  runWorkstreamStoreContract,
  type WorkstreamStoreContractHarness,
} from "../contract/workstream-store.contract.js";
import type { Storage } from "../../src/ports/storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const harness: WorkstreamStoreContractHarness = {
  name: "SqliteStorage",

  async setup(): Promise<Storage> {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-wsstore-"));
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    (storage as SqliteStorage & { _tmp: string })._tmp = tmp;
    return storage;
  },

  async teardown(storage: Storage): Promise<void> {
    const tmp = (storage as SqliteStorage & { _tmp: string })._tmp;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  },

  async seedEntity(storage: Storage, canonical: string): Promise<void> {
    (storage as SqliteStorage)
      .rawDb()
      .prepare(
        "INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')",
      )
      .run(canonical);
  },
};

runWorkstreamStoreContract(harness);

describe("SqliteWorkstreamStore: sqlite-specific assertions", () => {
  let storage: SqliteStorage;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-wsstore-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("touchLastSession stores the exact ISO string verbatim", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.touchLastSession("ws_1", "2026-06-24T00:00:00Z");
    expect((await storage.workstreams.getById("ws_1"))!.lastSessionAt).toBe("2026-06-24T00:00:00Z");
  });

  it("upsertEntities increments session_count on each call", async () => {
    storage
      .rawDb()
      .prepare(
        "INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')",
      )
      .run("NLM");
    storage
      .rawDb()
      .prepare(
        "INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')",
      )
      .run("Daemon");
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.upsertEntities("ws_1", ["NLM", "Daemon"]);
    await storage.workstreams.upsertEntities("ws_1", ["NLM"]);
    const counts = storage
      .rawDb()
      .prepare<[], { session_count: number }>(
        "SELECT session_count FROM workstream_entities WHERE workstream_id='ws_1' AND entity_canonical='NLM'",
      )
      .get();
    expect(counts!.session_count).toBe(2);
  });
});
