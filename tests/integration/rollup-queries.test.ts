import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import type { Fact } from "../../src/shared/types.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-rollup-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

const fact = (id: string, sid: string, over: Partial<Fact> = {}): Fact => ({
  id, kind: "decision", subject: "x", predicate: "is", value: "y",
  sourceSessionId: sid, sourceQuote: null, createdAt: "2026-06-24T00:00:00Z",
  supersededBy: null, confidence: 1, retiredAt: null, ...over,
});

describe("listBySessions", () => {
  it("returns current facts across multiple sessions, excluding superseded/retired", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2" }));
    await storage.facts.insertMany([
      fact("f1", "s1"),
      fact("f2", "s2"),
      fact("f3", "s1", { supersededBy: "f1" }),
      fact("f4", "s2", { retiredAt: "2026-06-24T01:00:00Z" }),
    ]);
    const ids = (await storage.facts.listBySessions(["s1", "s2"])).map((f) => f.id);
    expect(new Set(ids)).toEqual(new Set(["f1", "f2"]));
  });

  it("returns [] for empty input", async () => {
    expect(await storage.facts.listBySessions([])).toEqual([]);
    expect(await storage.exemplars.listBySessions([])).toEqual([]);
  });
});
