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

describe("SqliteFactStore.listBySubjects", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-list-by-subjects-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.db"), migrationsDir: MIGRATIONS_DIR });
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }), TENANT);
    storage.sessions.insertSessionForTest(makeSession({ id: "s2" }), OTHER);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty array without querying when given no subjects", async () => {
    expect(await storage.facts.listBySubjects(TENANT, [])).toEqual([]);
  });

  it("includes both current and superseded facts for the requested subjects", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
      makeFact({
        id: "f2",
        subject: "alpha",
        predicate: "p",
        sourceSessionId: "s1",
        supersededBy: "f1",
      }),
      makeFact({ id: "f3", subject: "beta", predicate: "p", sourceSessionId: "s1" }),
    ]);
    const result = await storage.facts.listBySubjects(TENANT, ["alpha"]);
    expect(result.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("never includes a retired fact, in current or superseded form", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
      makeFact({
        id: "f2",
        subject: "alpha",
        predicate: "q",
        sourceSessionId: "s1",
        supersededBy: "f1",
      }),
    ]);
    await storage.facts.retire(TENANT, "f1");
    await storage.facts.retire(TENANT, "f2");
    const result = await storage.facts.listBySubjects(TENANT, ["alpha"]);
    expect(result).toEqual([]);
  });

  it("never crosses tenants", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({ id: "f1", subject: "alpha", predicate: "p", sourceSessionId: "s1" }),
    ]);
    await storage.facts.insertMany(OTHER, [
      makeFact({ id: "f2", subject: "alpha", predicate: "p", sourceSessionId: "s2" }),
    ]);
    const result = await storage.facts.listBySubjects(TENANT, ["alpha"]);
    expect(result.map((f) => f.id)).toEqual(["f1"]);
  });

  it("returns every fact for a subject well past the old listForRecall default limit of 500", async () => {
    const facts = Array.from({ length: 600 }, (_, i) =>
      makeFact({
        id: `f${i}`,
        subject: "prolific",
        predicate: `p${i}`,
        sourceSessionId: "s1",
        createdAt: new Date(2026, 0, 1 + i).toISOString(),
      }),
    );
    await storage.facts.insertMany(TENANT, facts);
    const result = await storage.facts.listBySubjects(TENANT, ["prolific"]);
    expect(result).toHaveLength(600);
  });

  it("chunks a subject list well past SQLite's 999 host-parameter limit and returns every subject", async () => {
    const subjectCount = 1200;
    const facts = Array.from({ length: subjectCount }, (_, i) =>
      makeFact({
        id: `f${i}`,
        subject: `subject-${i}`,
        predicate: "p",
        sourceSessionId: "s1",
      }),
    );
    await storage.facts.insertMany(TENANT, facts);
    const subjects = facts.map((f) => f.subject);
    const result = await storage.facts.listBySubjects(TENANT, subjects);
    expect(result).toHaveLength(subjectCount);
    expect(new Set(result.map((f) => f.subject)).size).toBe(subjectCount);
  });

  it("orders results by subject, then createdAt, then id", async () => {
    await storage.facts.insertMany(TENANT, [
      makeFact({
        id: "z2",
        subject: "beta",
        predicate: "p",
        sourceSessionId: "s1",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      makeFact({
        id: "z1",
        subject: "beta",
        predicate: "q",
        sourceSessionId: "s1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeFact({
        id: "a1",
        subject: "alpha",
        predicate: "p",
        sourceSessionId: "s1",
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    const result = await storage.facts.listBySubjects(TENANT, ["beta", "alpha"]);
    expect(result.map((f) => f.id)).toEqual(["a1", "z1", "z2"]);
  });
});
