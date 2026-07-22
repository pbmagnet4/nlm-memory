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
 * resolve — the extension is installed database-wide, explicitly into
 * `public`; `CREATE EXTENSION IF NOT EXISTS vector` in migration 001 is then
 * a no-op regardless of search_path.
 *
 * Extension bootstrap race (found live, 2026-07-22): pgvector is a
 * relocatable extension, so an unqualified `CREATE EXTENSION IF NOT EXISTS
 * vector` installs into whatever schema resolves first in search_path — NOT
 * necessarily `public` — the first time it actually runs. On a database
 * where the extension doesn't exist yet, N test files starting file-parallel
 * all hit that first-ever creation concurrently: `IF NOT EXISTS` is a
 * check-then-act, not atomic, so concurrent callers either race a
 * `pg_extension_name_index` duplicate-key error, or one wins and installs
 * the extension INTO its own throwaway test schema — which then deletes the
 * extension along with everything else the moment that file's afterAll
 * drops the schema, leaving every subsequent migration failing with `type
 * "vector" does not exist`. Fix: bootstrap the extension explicitly into
 * `public` (bypassing search_path with `SCHEMA public`) under a pg advisory
 * lock before any schema is created, so every file agrees on one winner and
 * the extension never lives inside a schema that gets dropped.
 */
import { afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Arbitrary constant lock key, scoped to this bootstrap step only. */
const VECTOR_EXTENSION_LOCK_KEY = 848_301_247;

/**
 * pg_advisory_lock/unlock are session-scoped: the lock and its release must
 * run on the exact same physical connection. A `Pool`'s separate `.query()`
 * calls are not guaranteed to reuse one connection, so locking and
 * unlocking through `pool.query()` provides no real mutual exclusion (and
 * can leave the lock held on a connection nothing ever explicitly
 * releases). `pool.connect()` pins one PoolClient for the whole
 * lock/create/unlock sequence.
 */
async function ensureVectorExtension(baseUrl: string): Promise<void> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    const client = await admin.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [VECTOR_EXTENSION_LOCK_KEY]);
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [VECTOR_EXTENSION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } finally {
    await admin.end();
  }
}

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
  await ensureVectorExtension(baseUrl);
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
