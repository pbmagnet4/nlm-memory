/**
 * PgStorage adapter: WorkstreamStore contract.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent. Tables are truncated between tests for
 * isolation; schema is applied on first setup() call.
 */

import { describe } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWorkstreamStoreContract,
  type WorkstreamStoreContractHarness,
} from "../../tests/contract/workstream-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    workstream_entities, workstreams,
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

const harness: WorkstreamStoreContractHarness = {
  name: "PgStorage",

  async setup(): Promise<Storage> {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    const storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.pgPool().query(TRUNCATE_SQL);
    return storage;
  },

  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },

  async seedEntity(storage: Storage, canonical: string): Promise<void> {
    await (storage as PgStorage).pgPool().query(
      "INSERT INTO entities (canonical, type, status, source) VALUES ($1, 'candidate', 'candidate', 'test') ON CONFLICT DO NOTHING",
      [canonical],
    );
  },
};

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: workstream-store contract",
  () => {
    runWorkstreamStoreContract(harness);
  },
);
