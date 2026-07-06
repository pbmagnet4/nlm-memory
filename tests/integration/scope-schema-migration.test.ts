/**
 * Migration 029: additive scope column on sessions/facts/code_exemplars/signals/workstreams.
 * Verifies fresh-DB schema shape, NULL semantics on pre-existing rows, and
 * idempotent re-run. See docs/superpowers/specs/2026-07-03-project-scoping-design.md.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SCOPED_TABLES = ["sessions", "facts", "code_exemplars", "signals", "workstreams"] as const;

describe("migration 029 - project scope column", () => {
  it("creates scope column and index on all five tables (fresh DB)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-scope-fresh-"));
    try {
      const storage = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
      const db = storage.sessions.rawDb();

      for (const table of SCOPED_TABLES) {
        const cols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((r: any) => r.name as string);
        expect(cols, `${table}: scope column missing`).toContain("scope");

        const indexes = db
          .prepare(`PRAGMA index_list(${table})`)
          .all()
          .map((r: any) => r.name as string);
        expect(indexes, `${table}: idx_${table}_scope missing`).toContain(
          `idx_${table}_scope`,
        );
      }

      await storage.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pre-existing rows have scope NULL after migration applies", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-scope-null-"));
    try {
      const preDir = join(tmp, "pre");
      mkdirSync(preDir);
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        const m = /^(\d+)_/.exec(f);
        if (m && Number(m[1]) < 29) {
          copyFileSync(join(MIGRATIONS_DIR, f), join(preDir, f));
        }
      }

      const pre = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: preDir,
      });
      await pre.init();
      const preDb = pre.sessions.rawDb();
      preDb
        .prepare(
          `INSERT INTO sessions (id, runtime, started_at, label, summary, status)
           VALUES ('s_pre', 'test', '2026-01-01T00:00:00Z', 'L', 'S', 'active')`,
        )
        .run();
      preDb
        .prepare(
          `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
           VALUES ('f_pre', 'decision', 'subj', 'pred', 'val', 's_pre', 0.9)`,
        )
        .run();
      preDb
        .prepare(
          `INSERT INTO code_exemplars
             (id, install_scope, repo, model, task_context, code, code_hash, outcome, ts)
           VALUES ('x_pre', 'inst', 'repo-a', 'm', 'ctx', 'code', 'hash', 'pass',
                   '2026-01-01T00:00:00Z')`,
        )
        .run();
      preDb
        .prepare(
          `INSERT INTO signals (id, install_scope, kind, producer, outcome, model, repo, ts)
           VALUES ('sig_pre', 'inst', 'gate', 'prod', 'pass', 'm', 'repo-a',
                   '2026-01-01T00:00:00Z')`,
        )
        .run();
      preDb
        .prepare(`INSERT INTO workstreams (id, label) VALUES ('ws_pre', 'WS')`)
        .run();
      await pre.close();

      const full = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await full.init();
      const db = full.sessions.rawDb();

      for (const table of SCOPED_TABLES) {
        const counts = db
          .prepare<[], { total: number; stamped: number }>(
            `SELECT COUNT(*) AS total,
                    COUNT(scope) AS stamped
             FROM ${table}`,
          )
          .get();
        expect(counts?.total, `${table}: seeded row missing`).toBe(1);
        expect(counts?.stamped, `${table}: scope must be NULL`).toBe(0);
      }

      await full.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-running init after 029 is a no-op (idempotent)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-scope-idem-"));
    try {
      const storage = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
      await storage.init();

      const db = storage.sessions.rawDb();
      for (const table of SCOPED_TABLES) {
        const cols = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((r: any) => r.name as string);
        expect(cols).toContain("scope");
      }

      await storage.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
