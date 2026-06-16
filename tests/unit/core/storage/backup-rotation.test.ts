import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupFilename,
  backupsToPrune,
  listBackupDates,
  parseBackupDate,
  resolveBackup,
  runRollingBackup,
} from "../../../../src/core/storage/backup-rotation.js";

describe("parseBackupDate", () => {
  it("extracts the date from a backup filename", () => {
    expect(parseBackupDate("canonical-2026-06-16.sqlite")).toBe("2026-06-16");
  });
  it("rejects non-backup filenames", () => {
    expect(parseBackupDate("canonical.sqlite")).toBeNull();
    expect(parseBackupDate("notes.txt")).toBeNull();
    expect(parseBackupDate("canonical-2026-6-1.sqlite")).toBeNull();
  });
});

describe("backupsToPrune", () => {
  const files = [
    "canonical-2026-06-16.sqlite", // today
    "canonical-2026-06-15.sqlite",
    "canonical-2026-06-10.sqlite", // 6 days old
    "canonical-2026-06-09.sqlite", // 7 days old → prune at retention 7
    "canonical-2026-06-01.sqlite", // 15 days old → prune
    "canonical.sqlite", // not a dated backup → ignored
    "random.txt",
  ];

  it("prunes snapshots at or beyond the retention window", () => {
    const pruned = backupsToPrune(files, 7, "2026-06-16");
    expect(pruned).toContain("canonical-2026-06-09.sqlite");
    expect(pruned).toContain("canonical-2026-06-01.sqlite");
    expect(pruned).not.toContain("canonical-2026-06-10.sqlite");
    expect(pruned).not.toContain("canonical-2026-06-16.sqlite");
  });

  it("ignores non-backup files", () => {
    const pruned = backupsToPrune(files, 7, "2026-06-16");
    expect(pruned).not.toContain("canonical.sqlite");
    expect(pruned).not.toContain("random.txt");
  });

  it("prunes nothing when all snapshots are within the window", () => {
    expect(backupsToPrune(["canonical-2026-06-16.sqlite"], 7, "2026-06-16")).toEqual([]);
  });
});

describe("runRollingBackup (real sqlite)", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-backup-rotation-"));
    dbPath = join(tmp, "canonical.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('s1');");
    db.close();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes a dated snapshot and prunes expired ones", () => {
    // Seed an old snapshot that should be pruned.
    const dir = join(tmp, "backups");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "canonical-2026-06-01.sqlite"), "old");

    const db = new Database(dbPath, { readonly: true });
    const result = runRollingBackup(db, dbPath, "2026-06-16", 7);
    db.close();

    expect(existsSync(result.written)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pruned).toContain("canonical-2026-06-01.sqlite");
    expect(existsSync(join(dir, "canonical-2026-06-01.sqlite"))).toBe(false);
    // The new snapshot is a valid, restorable copy.
    const snap = new Database(result.written, { readonly: true });
    expect(snap.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    snap.close();
  });

  it("is idempotent on the same day and resolvable by date", () => {
    const db = new Database(dbPath, { readonly: true });
    runRollingBackup(db, dbPath, "2026-06-16", 7);
    runRollingBackup(db, dbPath, "2026-06-16", 7);
    db.close();

    const dates = listBackupDates(dbPath);
    expect(dates).toEqual(["2026-06-16"]);
    expect(resolveBackup(dbPath, "2026-06-16")).toBe(
      join(tmp, "backups", backupFilename("2026-06-16")),
    );
    expect(resolveBackup(dbPath, "2026-01-01")).toBeNull();
  });
});

describe("listBackupDates", () => {
  it("returns empty when no backups dir exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-backup-empty-"));
    try {
      expect(listBackupDates(join(tmp, "canonical.sqlite"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
