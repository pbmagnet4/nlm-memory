/**
 * Version-gated pg migration runner contract.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent.
 *
 * These tests exercise fresh-database migration behavior, so each `it`
 * creates and drops its own throwaway schema via the pg-test-schema helper's
 * primitives rather than sharing the file-level schema `usePgTestSchema`
 * would hand out — the whole point of these cases is to start from nothing,
 * which a single shared per-file schema can't provide across three tests.
 * `public` is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";
import { createPgTestSchema, dropPgTestSchema } from "../helpers/pg-test-schema.js";
import type { PgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

describe.skipIf(!PG_TEST_URL)("pg migration runner", () => {
  let handle: PgTestSchema;

  beforeEach(async () => {
    handle = await createPgTestSchema(PG_TEST_URL!, import.meta.url);
  });

  afterEach(async () => {
    await dropPgTestSchema(PG_TEST_URL!, handle.schema);
  });

  it("fresh database: applies all migrations in order and stamps schema_migrations", async () => {
    const storage = PgStorage.create({
      connectionString: handle.url,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();

    const { rows } = await storage.pgPool().query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32, 33, 34]);

    await storage.pgPool().query(
      "INSERT INTO workstreams (id, label) VALUES ('ws_test', 'Test WS')",
    );
    await storage.pgPool().query(
      `INSERT INTO sessions
         (id, runtime, started_at, label, summary, status, workstream_id)
       VALUES
         ('s_ws_test', 'claude-code', '2026-01-01T00:00:00Z', 'L', 'S', 'active', 'ws_test')`,
    );

    await storage.close();
  });

  it("re-running init is a no-op: row count and versions unchanged", async () => {
    const storage = PgStorage.create({
      connectionString: handle.url,
      migrationsDir: MIGRATIONS_DIR,
    });

    await storage.init();

    const { rows: before } = await storage
      .pgPool()
      .query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );

    const secondRun = await runMigrationsPg(storage.pgPool(), MIGRATIONS_DIR);

    const { rows: after } = await storage
      .pgPool()
      .query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );

    expect(secondRun).toHaveLength(0);
    expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
    expect(before.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32, 33, 34]);

    await storage.close();
  });

  it("existing manual-operator database: init stamps all versions without breaking", async () => {
    const storage = PgStorage.create({
      connectionString: handle.url,
      migrationsDir: MIGRATIONS_DIR,
    });

    for (const file of [
      "001_initial.sql",
      "019_split_replaces.sql",
      "025_workstreams.sql",
    ]) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await storage.pgPool().query(sql);
    }

    await storage.pgPool().query("DROP TABLE IF EXISTS schema_migrations");

    await expect(storage.init()).resolves.not.toThrow();

    const { rows } = await storage.pgPool().query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32, 33, 34]);

    await storage.close();
  });
});
