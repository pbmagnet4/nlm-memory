/**
 * Migration 032: additive derivable-metadata columns on sessions
 * (agent_persona, parent_session_id, primary_model, total_tokens, skill).
 * Verifies fresh-DB schema shape, NULL semantics on pre-existing rows, and
 * idempotent re-run. Schema-only task: stamping/backfill land in later
 * #352 phase-2 tasks.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const NEW_COLUMNS = [
  "agent_persona",
  "parent_session_id",
  "primary_model",
  "total_tokens",
  "skill",
] as const;

describe("migration 032 - session derivable columns", () => {
  it("creates all five columns and the parent index on sessions (fresh DB)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-derivables-fresh-"));
    try {
      const storage = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
      const db = storage.sessions.rawDb();

      const cols = db
        .prepare(`PRAGMA table_info(sessions)`)
        .all()
        .map((r: any) => r.name as string);
      for (const col of NEW_COLUMNS) {
        expect(cols, `sessions: ${col} column missing`).toContain(col);
      }

      const indexes = db
        .prepare(`PRAGMA index_list(sessions)`)
        .all()
        .map((r: any) => r.name as string);
      expect(indexes, "sessions: idx_sessions_parent missing").toContain(
        "idx_sessions_parent",
      );

      await storage.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pre-existing rows have all five columns NULL after migration applies", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-derivables-null-"));
    try {
      const preDir = join(tmp, "pre");
      mkdirSync(preDir);
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        const m = /^(\d+)_/.exec(f);
        if (m && Number(m[1]) < 32) {
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
      await pre.close();

      const full = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await full.init();
      const db = full.sessions.rawDb();

      const row = db
        .prepare<[], Record<string, unknown>>(
          `SELECT agent_persona, parent_session_id, primary_model, total_tokens, skill
           FROM sessions WHERE id = 's_pre'`,
        )
        .get();
      expect(row).toBeDefined();
      for (const col of NEW_COLUMNS) {
        expect(row?.[col], `sessions.${col} must be NULL`).toBeNull();
      }

      await full.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-running init after 032 is a no-op (idempotent)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-derivables-idem-"));
    try {
      const storage = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
      await storage.init();

      const db = storage.sessions.rawDb();
      const cols = db
        .prepare(`PRAGMA table_info(sessions)`)
        .all()
        .map((r: any) => r.name as string);
      for (const col of NEW_COLUMNS) {
        expect(cols).toContain(col);
      }

      await storage.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
