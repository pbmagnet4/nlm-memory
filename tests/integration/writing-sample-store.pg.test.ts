/**
 * PgStorage adapter — WritingSampleStore contract (T2438 piece A).
 *
 * Requires the repository's test-only PostgreSQL+pgvector instance; see
 * docker-compose.pg-test.yml for the command that starts it and the
 * NLM_PG_TEST_URL it expects. Skips when that env var is absent, so the suite
 * stays green without a container (same pattern as every other *.pg.test.ts).
 */

import { describe } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWritingSampleStoreContract } from "../contract/writing-sample-store.contract.js";
import type { WritingSampleStoreContractHarness } from "../contract/writing-sample-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";
import type { Storage } from "../../src/ports/storage.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");
const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
const INSTALL_SCOPE = "install-contract-test";

const TRUNCATE_SQL = "TRUNCATE TABLE writing_sample_embeddings, writing_samples RESTART IDENTITY CASCADE";

const harness: WritingSampleStoreContractHarness = {
  name: "PgStorage",
  installScope: INSTALL_SCOPE,
  async setup(): Promise<Storage> {
    const storage = PgStorage.create({
      connectionString: pgUrl(),
      migrationsDir: MIGRATIONS_DIR,
      installScopeProvider: () => INSTALL_SCOPE,
    });
    await storage.init();
    await storage.pgPool().query(TRUNCATE_SQL);
    return storage;
  },
  async teardown(storage) {
    await storage.close();
  },
  async ensureTeam(storage, teamId) {
    await (storage as PgStorage)
      .pgPool()
      .query("INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [teamId]);
  },
  async rawSample(storage, id) {
    const res = await (storage as PgStorage).pgPool().query<{ install_scope: string; text_hash: string; tenant_id: string }>(
      "SELECT install_scope, text_hash, tenant_id FROM writing_samples WHERE id = $1",
      [id],
    );
    return res.rows[0] ?? null;
  },
  async hasVector(storage, id) {
    const res = await (storage as PgStorage)
      .pgPool()
      .query("SELECT 1 FROM writing_sample_embeddings WHERE sample_id = $1", [id]);
    return res.rows.length > 0;
  },
};

describe.skipIf(!PG_TEST_URL)("PgStorage: writing-sample-store contract", () => {
  runWritingSampleStoreContract(harness);
});
