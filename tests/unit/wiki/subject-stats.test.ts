import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import { makeSession } from "../../fixtures/sessions.js";
import { makeFact } from "../../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../migrations");

const TENANT = "team_local";
const OTHER = "team_other";

describe("SqliteFactStore.listSubjectStats", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-subject-stats-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.db"), migrationsDir: MIGRATIONS_DIR });
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }), TENANT);
    storage.sessions.insertSessionForTest(makeSession({ id: "s2" }), TENANT);
    storage.sessions.insertSessionForTest(makeSession({ id: "s3" }), OTHER);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts facts and distinct sessions per subject", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
      makeFact({ id: "f2", subject: "alpha", predicate: "q", sourceSessionId: "s1" }),
      makeFact({ id: "f3", subject: "alpha", predicate: "r", sourceSessionId: "s2" }),
      makeFact({ id: "f4", subject: "beta", predicate: "p", sourceSessionId: "s1" }),
    ]);
    const stats = await storage.facts.listSubjectStats(TENANT);
    const alpha = stats.find((s) => s.subject === "alpha");
    expect(alpha).toEqual({ subject: "alpha", factCount: 3, sessionCount: 2 });
    const beta = stats.find((s) => s.subject === "beta");
    expect(beta).toEqual({ subject: "beta", factCount: 1, sessionCount: 1 });
  });

  it("excludes superseded facts", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
      makeFact({
        id: "f2",
        subject: "alpha",
        predicate: "q",
        sourceSessionId: "s2",
        supersededBy: "f1",
      }),
    ]);
    const stats = await storage.facts.listSubjectStats(TENANT);
    expect(stats.find((s) => s.subject === "alpha")).toEqual({
      subject: "alpha",
      factCount: 1,
      sessionCount: 1,
    });
  });

  it("excludes retired facts", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
    ]);
    await storage.facts.retire(TENANT, "f1");
    const stats = await storage.facts.listSubjectStats(TENANT);
    expect(stats.find((s) => s.subject === "alpha")).toBeUndefined();
  });

  it("never counts another tenant's facts", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
    ]);
    await storage.facts.insertMany(OTHER, [
      makeFact({ id: "f2", subject: "alpha", predicate: "p", sourceSessionId: "s3" }),
      makeFact({ id: "f3", subject: "gamma", predicate: "p", sourceSessionId: "s3" }),
    ]);
    const stats = await storage.facts.listSubjectStats(TENANT);
    expect(stats.find((s) => s.subject === "alpha")).toEqual({
      subject: "alpha",
      factCount: 1,
      sessionCount: 1,
    });
    expect(stats.find((s) => s.subject === "gamma")).toBeUndefined();
  });

  it("returns an empty array for a tenant with no facts", async () => {
    expect(await storage.facts.listSubjectStats("team_empty")).toEqual([]);
  });
});
