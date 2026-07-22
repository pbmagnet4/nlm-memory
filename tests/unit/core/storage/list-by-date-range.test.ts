import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

// Matches the construction used by other sqlite-session-store tests.
const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function insert(storage: SqliteStorage, id: string, startedAt: string, endedAt: string | null) {
  await storage.sessions.insertSession("team_local", {
    id, runtime: "claude-code", runtimeSessionId: id, startedAt, endedAt,
    durationMin: null, label: id, summary: "", body: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/tmp/${id}.jsonl`,
    transcriptOffset: null, transcriptLength: null,
    entities: [], decisions: [], openQuestions: [], scope: null,
  });
}

describe("SqliteSessionStore.listByDateRange", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-lbdr-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns sessions whose lifespan overlaps the window", async () => {
    await insert(storage, "in_day", "2026-06-23T10:00:00.000Z", "2026-06-23T11:00:00.000Z");
    await insert(storage, "before", "2026-06-21T10:00:00.000Z", "2026-06-21T11:00:00.000Z");
    await insert(storage, "spanning", "2026-06-22T23:00:00.000Z", "2026-06-23T01:00:00.000Z");
    await insert(storage, "open_old", "2026-06-20T10:00:00.000Z", null);

    const got = await storage.sessions.listByDateRange("team_local", 
      "2026-06-23T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
    );
    const ids = got.map((s) => s.id).sort();
    // in_day overlaps; spanning overlaps at the start of the day; open_old is
    // still open so it overlaps; before does not.
    expect(ids).toEqual(["in_day", "open_old", "spanning"]);
  });
});
