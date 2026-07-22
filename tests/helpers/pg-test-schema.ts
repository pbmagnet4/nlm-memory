// tests/helpers/pg-test-schema.ts
/**
 * Per-file pg test schema isolation (M7, program spec §5).
 *
 * Every *.pg.test.ts file gets its own uniquely-named schema instead of
 * sharing the connection's default `public` schema. This lets the pg suite
 * run file-parallel: two files' migrations, truncates, and DDL never touch
 * the same tables.
 *
 * Mechanism: a Pool built from a connection string carrying a libpq `options`
 * parameter (`-c search_path=<schema>,public`) resolves every unqualified
 * table/type reference against `<schema>` first. `public` stays second in
 * the path so unqualified references to pgvector's `vector` type still
 * resolve — the extension is installed once, database-wide, in `public` (see
 * README/setup); `CREATE EXTENSION IF NOT EXISTS vector` in migration 001 is
 * then a no-op in every other schema. Verified live against NLM_PG_TEST_URL
 * on 2026-07-22: concurrent schemas each get their own `schema_migrations`
 * and corpus tables, and `vector(N)` columns resolve correctly with the test
 * schema first in search_path.
 */
import { afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface PgTestSchema {
  readonly schema: string;
  readonly url: string;
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** Postgres identifiers cap at 63 bytes; leave room for the random suffix. */
function schemaNameFor(fileUrl: string): string {
  const base = sanitize(basename(fileURLToPath(fileUrl)).replace(/\.pg\.test\.ts$/, "")).slice(0, 40);
  const suffix = randomBytes(4).toString("hex");
  return `t_${base}_${suffix}`;
}

function schemaScopedUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

/** Creates a fresh, empty schema on the target database. Caller owns teardown via dropPgTestSchema. */
export async function createPgTestSchema(baseUrl: string, fileUrl: string): Promise<PgTestSchema> {
  const schema = schemaNameFor(fileUrl);
  const admin = new Pool({ connectionString: baseUrl });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  return { schema, url: schemaScopedUrl(baseUrl, schema) };
}

export async function dropPgTestSchema(baseUrl: string, schema: string): Promise<void> {
  const admin = new Pool({ connectionString: baseUrl });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
}

/**
 * Registers file-scoped beforeAll/afterAll hooks that create one isolated pg
 * schema for the calling test file and drop it once all its tests finish.
 * Call at module scope (not inside a describe) so one schema backs every
 * describe block in the file. Returns an accessor for the schema-scoped
 * connection string; pass its result wherever the file previously passed
 * `PG_TEST_URL!` as `connectionString`.
 *
 * `baseUrl` is expected undefined only when NLM_PG_TEST_URL is unset, in
 * which case every describe in the file is already gated behind
 * `describe.skipIf(!PG_TEST_URL)` and this accessor is never called.
 */
export function usePgTestSchema(baseUrl: string | undefined, fileUrl: string): () => string {
  let handle: PgTestSchema | undefined;

  beforeAll(async () => {
    if (!baseUrl) return;
    handle = await createPgTestSchema(baseUrl, fileUrl);
  });

  afterAll(async () => {
    if (baseUrl && handle) {
      await dropPgTestSchema(baseUrl, handle.schema);
    }
  });

  return () => {
    if (!handle) {
      throw new Error("pg test schema not initialized (NLM_PG_TEST_URL unset or beforeAll did not run)");
    }
    return handle.url;
  };
}
