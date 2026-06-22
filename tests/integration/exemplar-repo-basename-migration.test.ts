/**
 * Migration 024: backfills code_exemplars.repo from absolute host paths to
 * logical basenames. Seeds the leak shape (the pre-#330 session-capture path
 * stamped projectDir into repo) on a migrated schema, applies the backfill SQL,
 * and asserts every repo is a basename — and that already-logical repos and
 * names containing spaces are handled correctly.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const BACKFILL_SQL = readFileSync(
  join(MIGRATIONS_DIR, "024_backfill_exemplar_repo_basename.sql"),
  "utf8",
);

describe("migration 024 — backfill exemplar repo basenames", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-repobackfill-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("strips host-path prefixes, leaves logical names untouched", async () => {
    const db = storage.sessions.rawDb();
    const insert = db.prepare(
      `INSERT INTO code_exemplars
       (id, install_scope, repo, model, task_context, code, code_hash, outcome, ts)
       VALUES (?, 'scope', ?, 'm', 't', 'code', ?, 'pass', '2026-06-22T00:00:00Z')`,
    );
    insert.run("a", "/home/dev/projects/nlm-memory", "h1");
    insert.run("b", "/home/dev/projects/Demo Workspace", "h2"); // name with a space
    insert.run("c", "nlm-memory", "h3"); // already logical

    db.exec(BACKFILL_SQL);

    const repoOf = (id: string) =>
      db.prepare<[string], { repo: string }>("SELECT repo FROM code_exemplars WHERE id = ?").get(id)?.repo;
    expect(repoOf("a")).toBe("nlm-memory");
    expect(repoOf("b")).toBe("Demo Workspace");
    expect(repoOf("c")).toBe("nlm-memory");

    const leaked = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM code_exemplars WHERE repo LIKE '/%'")
      .get();
    expect(leaked?.c).toBe(0);
  });
});
