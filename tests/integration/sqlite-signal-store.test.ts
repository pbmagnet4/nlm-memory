import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "../../src/ports/storage.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runSignalStoreContract } from "../contract/signal-store.contract.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const tmpDirs = new WeakMap<Storage, string>();

runSignalStoreContract({
  name: "sqlite",
  async setup() {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-signals-"));
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    tmpDirs.set(storage, tmp);
    return storage;
  },
  async teardown(storage) {
    const tmp = tmpDirs.get(storage);
    await storage.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  },
});
