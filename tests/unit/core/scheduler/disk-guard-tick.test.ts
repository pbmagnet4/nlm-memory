/**
 * T1772 Part 3 (scheduler side): a tripped disk guard pauses the whole
 * ingest/dream tick — ingest writes, and the dream passes run at the tick
 * tail, so one gate covers both. The not-tripped path proves the gate is a
 * pass-through, not an accidental always-skip.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

let tmp: string;
let storage: SqliteStorage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-sched-diskguard-"));
  // Keep the 24h cheap-integrity-cache out of the developer's ~/.nlm and
  // pre-stamped "just ran" so it never fires (or writes) during these ticks.
  process.env["NLM_INTEGRITY_CACHE"] = join(tmp, "integrity-cache.json");
  storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterAll(async () => {
  await storage.close();
});

function makeScheduler(diskGuard: { shouldSkip(job: string): Promise<boolean> } | undefined, spy: () => void) {
  const scheduler = new ScanScheduler({
    store: storage.sessions,
    adapters: [],
    classifier: {
      embed: async () => { throw new Error("stub"); },
      classify: async () => { throw new Error("stub"); },
      rewriteForRecall: async () => { throw new Error("stub"); },
      nameWorkstream: async () => { throw new Error("stub"); },
    },
    embedder: null,
    idleMinutes: 0,
    logger: () => {},
    ...(diskGuard ? { diskGuard } : {}),
  });
  scheduler.registerDreamPass({ name: "test-pass", intervalMs: 1, run: async () => { spy(); } });
  return scheduler;
}

describe("ScanScheduler disk guard", () => {
  it("tripped guard skips the tick: zero report, no dream pass, one gate call", async () => {
    const seen: string[] = [];
    let ran = 0;
    const scheduler = makeScheduler({
      shouldSkip: async (job) => { seen.push(job); return true; },
    }, () => { ran += 1; });
    const report = await scheduler.tick();
    expect(seen).toEqual(["scheduler-tick"]);
    expect(ran).toBe(0);
    expect(report).toEqual({
      inserted: 0, gatedSkips: 0, skippedLowConfidence: 0,
      classifyFailures: 0, storageFailures: 0, chunksSeen: 0, deferred: 0,
    });
  });

  it("clear guard lets the tick through (dream pass still runs)", async () => {
    let ran = 0;
    const scheduler = makeScheduler({ shouldSkip: async () => false }, () => { ran += 1; });
    await scheduler.tick();
    expect(ran).toBe(1);
  });

  it("no guard wired keeps the old behavior", async () => {
    let ran = 0;
    const scheduler = makeScheduler(undefined, () => { ran += 1; });
    await scheduler.tick();
    expect(ran).toBe(1);
  });
});
