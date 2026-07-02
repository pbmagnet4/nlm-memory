/**
 * Version-gated PostgreSQL migration runner. Reads versioned *.sql files from
 * a directory, applies any whose integer prefix is not yet in schema_migrations,
 * and returns the list of newly applied versions. Idempotent: re-running on an
 * up-to-date database is a no-op.
 *
 * Migration files that contain their own BEGIN/COMMIT markers have those lines
 * stripped; the runner wraps each file in a single transaction instead. A file
 * whose first line is `-- nlm:no-wrap` is executed as-is (manages its own
 * transaction). No pg migration files use that convention today; the check is
 * kept for parity with the sqlite runner.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

const FILE_PATTERN = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

function stripTransactionMarkers(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\s*(?:BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

export async function runMigrationsPg(
  pool: Pool,
  migrationsDir: string,
): Promise<ReadonlyArray<AppliedMigration>> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: appliedRows } = await pool.query<{ version: number }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set<number>(appliedRows.map((r) => r.version));

  const files = readdirSync(migrationsDir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort();

  const newlyApplied: AppliedMigration[] = [];

  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2] ?? file;
    if (applied.has(version)) continue;

    const rawSql = readFileSync(join(migrationsDir, file), "utf8");
    const noWrap = rawSql.startsWith("-- nlm:no-wrap");
    const client = await pool.connect();
    try {
      if (noWrap) {
        await client.query(rawSql);
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [version, name],
        );
      } else {
        const sql = stripTransactionMarkers(rawSql);
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [version, name],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(
            `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      client.release();
    }

    newlyApplied.push({ version, name });
  }

  return newlyApplied;
}
