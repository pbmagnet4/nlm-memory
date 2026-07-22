import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wsproj-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("listByDateRange surfaces workstream_id", () => {
  it("returns workstreamId when the session is bound, null otherwise", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", startedAt: "2026-06-24T10:00:00.000Z" }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2", startedAt: "2026-06-24T11:00:00.000Z" }));
    await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
    await storage.sessions.setWorkstreamBinding("team_local", "s1", "ws_1", "classifier", 0.9);

    const rows = await storage.sessions.listByDateRange("team_local", "2026-06-24T00:00:00.000Z", "2026-06-25T00:00:00.000Z");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("s1")!.workstreamId).toBe("ws_1");
    expect(byId.get("s2")!.workstreamId ?? null).toBeNull();
  });
});
