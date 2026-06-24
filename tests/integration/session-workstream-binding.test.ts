// tests/integration/session-workstream-binding.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-sb-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("session workstream binding", () => {
  it("sets and reads a session's workstream binding via list", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["NLM", "Daemon"] }));
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.sessions.setWorkstreamBinding("s1", "ws_1", "classifier", 0.82);
    const ids = await storage.sessions.listSessionIdsByWorkstreams(["ws_1"]);
    expect(ids).toEqual(["s1"]);
  });

  it("getEntities returns the session's entities", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["NLM", "Daemon"] }));
    expect(new Set(await storage.sessions.getEntities("s1"))).toEqual(new Set(["NLM", "Daemon"]));
  });

  it("listSessionIdsByWorkstreams unions multiple workstreams", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["A"] }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2", entities: ["B"] }));
    await storage.workstreams.create({ id: "ws_1", label: "One" });
    await storage.workstreams.create({ id: "ws_2", label: "Two" });
    await storage.sessions.setWorkstreamBinding("s1", "ws_1", "classifier", 0.9);
    await storage.sessions.setWorkstreamBinding("s2", "ws_2", "classifier", 0.9);
    expect(new Set(await storage.sessions.listSessionIdsByWorkstreams(["ws_1", "ws_2"]))).toEqual(new Set(["s1", "s2"]));
  });
});
