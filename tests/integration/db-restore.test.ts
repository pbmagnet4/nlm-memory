/**
 * Backup + restore integration. Real SQLite stores, VACUUM INTO snapshot,
 * candidate validation, staged restore, and boot-time promotion.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import {
  PENDING_SUFFIX,
  applyPendingRestore,
  snapshotScratchPath,
  stageRestore,
  validateRestoreCandidate,
  vacuumSnapshot,
} from "../../src/core/storage/db-restore.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function insertMarkerSource(db: Database.Database, name: string, runtimeLabel: string): void {
  db.prepare(
    "INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled) " +
    "VALUES ('webhook', ?, NULL, ?, '{}', 1)",
  ).run(name, runtimeLabel);
}

describe("db-restore", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-restore-"));
    dbPath = join(tmp, "canonical.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function freshStore(path: string): SqliteSessionStore {
    return new SqliteSessionStore({ dbPath: path, migrationsDir: MIGRATIONS_DIR });
  }

  it("vacuumSnapshot writes a valid standalone copy", () => {
    const store = freshStore(dbPath);
    const snap = snapshotScratchPath(dbPath);
    const bytes = vacuumSnapshot(store.rawDb(), snap);
    store.close();

    expect(bytes).toBeGreaterThan(0);
    expect(statSync(snap).size).toBe(bytes);
    expect(validateRestoreCandidate(snap).ok).toBe(true);
    rmSync(snap, { force: true });
  });

  it("validateRestoreCandidate rejects a non-SQLite file", () => {
    const junk = join(tmp, "junk.sqlite");
    writeFileSync(junk, "this is not a database");
    const result = validateRestoreCandidate(junk);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("validateRestoreCandidate rejects a SQLite file lacking nlm tables", () => {
    const bare = join(tmp, "bare.sqlite");
    const store = freshStore(bare);
    store.rawDb().prepare("DROP TABLE sessions").run();
    store.close();
    const result = validateRestoreCandidate(bare);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sessions/);
  });

  it("validateRestoreCandidate reports session count and schema version", () => {
    const store = freshStore(dbPath);
    const snap = snapshotScratchPath(dbPath);
    vacuumSnapshot(store.rawDb(), snap);
    store.close();

    const result = validateRestoreCandidate(snap);
    expect(result.ok).toBe(true);
    expect(result.sessions).toBe(0);
    expect(result.schemaVersion).toBeGreaterThanOrEqual(0);
    rmSync(snap, { force: true });
  });

  it("stageRestore parks a valid candidate at the pending path", () => {
    const store = freshStore(dbPath);
    const snap = snapshotScratchPath(dbPath);
    vacuumSnapshot(store.rawDb(), snap);
    store.close();

    const result = stageRestore(dbPath, snap);
    expect(result.ok).toBe(true);
    expect(existsSync(dbPath + PENDING_SUFFIX)).toBe(true);
    expect(existsSync(snap)).toBe(false); // candidate was renamed, not copied
  });

  it("stageRestore removes the candidate when validation fails", () => {
    const junk = join(tmp, "junk.sqlite");
    writeFileSync(junk, "not a database");
    const result = stageRestore(dbPath, junk);
    expect(result.ok).toBe(false);
    expect(existsSync(junk)).toBe(false);
    expect(existsSync(dbPath + PENDING_SUFFIX)).toBe(false);
  });

  it("applyPendingRestore is a no-op when nothing is staged", () => {
    freshStore(dbPath).close();
    const result = applyPendingRestore(dbPath);
    expect(result.applied).toBe(false);
  });

  it("applyPendingRestore promotes the staged DB and archives the current one", () => {
    // Current DB: one source seeded so we can tell the two stores apart.
    const current = freshStore(dbPath);
    insertMarkerSource(current.rawDb(), "marker-current", "current");
    current.close();

    // Staged DB: built elsewhere, carries a different marker source.
    const stagedSrc = join(tmp, "staged-src.sqlite");
    const staged = freshStore(stagedSrc);
    insertMarkerSource(staged.rawDb(), "marker-staged", "staged");
    const snap = snapshotScratchPath(dbPath);
    vacuumSnapshot(staged.rawDb(), snap);
    staged.close();
    expect(stageRestore(dbPath, snap).ok).toBe(true);

    const result = applyPendingRestore(dbPath);
    expect(result.applied).toBe(true);
    expect(result.archivedTo).toBeTruthy();
    expect(existsSync(result.archivedTo!)).toBe(true);
    expect(existsSync(dbPath + PENDING_SUFFIX)).toBe(false);

    // The promoted DB is the staged one.
    const reopened = freshStore(dbPath);
    const names = reopened
      .rawDb()
      .prepare<[], { name: string }>("SELECT name FROM sources")
      .all()
      .map((r) => r.name);
    reopened.close();
    expect(names).toContain("marker-staged");
    expect(names).not.toContain("marker-current");

    // Exactly one pre-restore archive was created.
    const archives = readdirSync(tmp).filter((f) => f.includes(".pre-restore-"));
    expect(archives.length).toBe(1);
  });
});
