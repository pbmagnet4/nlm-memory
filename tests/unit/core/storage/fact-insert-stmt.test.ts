import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../../../fixtures/sessions.js";
import { makeFact } from "../../../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

describe("SqliteFactStore insert statement caching", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-insertstmt-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.db"), migrationsDir: MIGRATIONS_DIR });
    storage.sessions.insertSessionForTest(makeSession({ id: "sess_parent" }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses one prepared statement across repeated single inserts", async () => {
    const store = storage.facts as unknown as { insertStmt(): unknown };
    const first = store.insertStmt();
    const second = store.insertStmt();
    expect(second).toBe(first);
  });

  it("cached statement inserts each fact correctly", async () => {
    await storage.facts.insert(makeFact({ id: "fact_1", sourceSessionId: "sess_parent" }));
    await storage.facts.insert(makeFact({ id: "fact_2", sourceSessionId: "sess_parent" }));
    expect(await storage.facts.getById("fact_1")).not.toBeNull();
    expect(await storage.facts.getById("fact_2")).not.toBeNull();
  });
});
