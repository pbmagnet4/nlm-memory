import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectLocalSource } from "../../../src/install/local-source.js";
import { SqliteStorage } from "../../../src/core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../../src/core/tenancy/default-team.js";

const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

describe("connectLocalSource", () => {
  let dir: string;
  let storage: SqliteStorage;
  let dbFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-local-src-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "nlm.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    dbFile = join(dir, "opencode.db");
    writeFileSync(dbFile, "");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const spec = () => ({ kind: "opencode" as const, name: "OpenCode", runtimeLabel: "opencode/1.0", path: dbFile });

  it("inserts an enabled source row when none exists", async () => {
    const report = await connectLocalSource(storage.sources, DEFAULT_TEAM_ID, spec());
    expect(report.action).toBe("created");
    const row = await storage.sources.getByName(DEFAULT_TEAM_ID, "OpenCode");
    expect(row).toMatchObject({ kind: "opencode", pathOrUrl: dbFile, enabled: true });
  });

  it("is idempotent on a second connect", async () => {
    await connectLocalSource(storage.sources, DEFAULT_TEAM_ID, spec());
    const report = await connectLocalSource(storage.sources, DEFAULT_TEAM_ID, spec());
    expect(report.action).toBe("already-active");
    expect((await storage.sources.list(DEFAULT_TEAM_ID)).filter((r) => r.name === "OpenCode")).toHaveLength(1);
  });

  it("registers a muse source, which the sources CHECK must accept", async () => {
    const report = await connectLocalSource(storage.sources, DEFAULT_TEAM_ID, {
      kind: "muse", name: "Muse", runtimeLabel: "muse/1.0", path: dir,
    });
    expect(report.action).toBe("created");
  });

  it("writes nothing on dry run", async () => {
    const report = await connectLocalSource(storage.sources, DEFAULT_TEAM_ID, spec(), { dryRun: true });
    expect(report.action).toBe("dry-run");
    expect(await storage.sources.getByName(DEFAULT_TEAM_ID, "OpenCode")).toBeNull();
  });
});
