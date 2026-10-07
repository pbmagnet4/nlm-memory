/**
 * SqliteStorage adapter: LearnerStore contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe } from "vitest";
import {
  runLearnerStoreContract,
  type LearnerStoreContractHarness,
} from "../contract/learner-store.contract.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { Storage } from "../../src/ports/storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nlm-learner-store-"));
}

const harness: LearnerStoreContractHarness = {
  name: "SqliteStorage",

  async setup(): Promise<Storage> {
    const tmp = makeTmpDir();
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "test.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    (storage as unknown as { _tmp: string })._tmp = tmp;
    return storage;
  },

  async teardown(storage: Storage): Promise<void> {
    const tmp = (storage as unknown as { _tmp: string })._tmp;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  },

  async ensureTeam(storage: Storage, teamId: string): Promise<void> {
    const db = (storage as SqliteStorage).rawDb();
    db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(teamId, teamId);
  },
};

describe("SqliteStorage: learner-store contract", () => {
  runLearnerStoreContract(harness);
});
