/**
 * T1772 Part 4: the restore drill against real snapshots. The fixture is a
 * migrated canonical DB (sessions + sessions_fts + facts all present), so
 * the three queries exercise the same schema a real backup carries.
 */
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { pickNewestBackup, runRestoreDrill } from "../../../../src/core/storage/restore-drill.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

let tmp: string;
let backupFile: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-restore-drill-"));
  const dbPath = join(tmp, "canonical.sqlite");
  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  await storage.close();
  backupFile = join(tmp, "canonical-snapshot.sqlite");
  copyFileSync(dbPath, backupFile);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runRestoreDrill", () => {
  it("passes a healthy snapshot and cleans up its temp dir", () => {
    const drillRoot = mkdtempSync(join(tmp, "drill-root-"));
    const report = runRestoreDrill({ backupFile, tmpRoot: drillRoot });
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ["integrity_check", true],
      ["session count", true],
      [`keyword recall (sessions_fts MATCH "memory")`, true],
      ["fact lookup", true],
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "session count")!.detail).toBe("0 sessions");
    // Nothing left behind, and the source snapshot was not opened for write.
    expect(readdirSync(drillRoot)).toEqual([]);
  });

  it("fails (does not throw) on a file that is not a database", () => {
    const bad = join(tmp, "canonical-bad.sqlite");
    writeFileSync(bad, "definitely not sqlite");
    const report = runRestoreDrill({ backupFile: bad, tmpRoot: tmp });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    // The report shape survives either failure mode (open threw vs check fail).
    expect(report.backup).toBe("canonical-bad.sqlite");
  });

  it("fails when the store's own tables are missing", () => {
    // A valid sqlite file that is not an nlm store: integrity ok, session
    // count must fail.
    const foreign = join(tmp, "canonical-foreign.sqlite");
    const db = new Database(foreign);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    const report = runRestoreDrill({ backupFile: foreign, tmpRoot: tmp });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "integrity_check")!.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "session count")!.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "session count")!.detail).toMatch(/no such table/);
  });

  it("honours a custom keyword", () => {
    const report = runRestoreDrill({ backupFile, tmpRoot: tmp, keyword: "walnut" });
    expect(report.ok).toBe(true);
    expect(report.checks[2]!.name).toContain('MATCH "walnut"');
  });
});

describe("pickNewestBackup", () => {
  it("returns null for a missing dir", () => {
    expect(pickNewestBackup(join(tmp, "nope"))).toBeNull();
  });

  it("picks the most recent mtime across both naming generations", () => {
    const dir = join(tmp, "backups");
    const old = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const newer = Date.parse("2026-11-10T00:00:00Z") / 1000;
    mkdirSync(dir, { recursive: true });
    for (const [name, t] of [
      ["canonical-2026-11-02.sqlite", old],
      ["canonical-202611101200.sqlite", newer],
      ["canonical-202611091200.sqlite", old + 10],
      ["notes.txt", Date.now() / 1000],
    ] as const) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), t, t);
    }
    expect(pickNewestBackup(dir)).toBe(join(dir, "canonical-202611101200.sqlite"));
  });
});
