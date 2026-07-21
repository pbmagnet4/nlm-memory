/**
 * session_edges.kind parity — PostgreSQL backend.
 *
 * SQLite migration 019 widens session_edges.kind to five values
 * (supersedes, replaces, continues, branched_from, merged_from). The pg
 * parity migration (pg/019) only widened to three; this test locks in the
 * remaining two once pg/031 closes the gap.
 *
 * Requires NLM_PG_TEST_URL. Skips when absent.
 *
 * Quick start:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
 *   NLM_PG_TEST_URL=postgres://postgres:test@localhost:54329/postgres npx vitest run tests/integration/session-edges-parity.pg.test.ts
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

async function insertSession(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, runtime, started_at, label, summary, status)
     VALUES ($1, 'claude-code', '2026-05-01T10:00:00Z', 'L', 'S', 'closed')`,
    [id],
  );
}

async function insertEdgePair(pool: Pool, kind: string): Promise<void> {
  const from = `edge_from_${kind}`;
  const to = `edge_to_${kind}`;
  await insertSession(pool, from);
  await insertSession(pool, to);
  await pool.query(
    "INSERT INTO session_edges (from_session, to_session, kind) VALUES ($1, $2, $3)",
    [from, to, kind],
  );
}

describe.skipIf(!PG_TEST_URL)("session_edges.kind parity (PostgreSQL)", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeEach(async () => {
    storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    pool = storage.pgPool();
    await pool.query(TRUNCATE_SQL);
  });

  afterEach(async () => {
    await storage.close();
  });

  it("accepts all five edge kinds that SQLite accepts", async () => {
    const kinds = ["supersedes", "replaces", "continues", "branched_from", "merged_from"];
    for (const kind of kinds) {
      await expect(insertEdgePair(pool, kind)).resolves.not.toThrow();
    }
  });
});
