/**
 * Version-gated pg migration runner contract.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent.
 *
 * IMPORTANT: These tests DROP and recreate the public schema to simulate a
 * fresh database. afterAll re-runs the full migration runner so that the
 * schema is left fully migrated for subsequent pg test files in the serial
 * pass.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

describe.skipIf(!PG_TEST_URL)("pg migration runner", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_TEST_URL });
  });

  afterAll(async () => {
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.close();
    await pool.end();
  });

  it("fresh database: applies all migrations in order and stamps schema_migrations", async () => {
    await resetSchema(pool);

    const storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();

    const { rows } = await storage.pgPool().query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32]);

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
    await resetSchema(pool);

    const storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
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
    expect(before.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32]);

    await storage.close();
  });

  it("existing manual-operator database: init stamps all versions without breaking", async () => {
    await resetSchema(pool);

    for (const file of [
      "001_initial.sql",
      "019_split_replaces.sql",
      "025_workstreams.sql",
    ]) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await pool.query(sql);
    }

    await pool.query("DROP TABLE IF EXISTS schema_migrations");

    const storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await expect(storage.init()).resolves.not.toThrow();

    const { rows } = await storage.pgPool().query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual([1, 19, 25, 26, 28, 29, 30, 31, 32]);

    await storage.close();
  });
});
