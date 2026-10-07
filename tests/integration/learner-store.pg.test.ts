/**
 * PgStorage adapter — LearnerStore contract.
 *
 * Requires a running PostgreSQL instance (NLM_PG_TEST_URL). Skips when the
 * env var is absent. Learner tables are truncated between tests for
 * isolation; schema is applied on first setup() call.
 */

import { describe } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLearnerStoreContract } from "../../tests/contract/learner-store.contract.js";
import type { LearnerStoreContractHarness } from "../../tests/contract/learner-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    learning_events, enrollments, learners,
    workstream_entities, workstreams
  RESTART IDENTITY CASCADE
`;

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: learner-store contract",
  () => {
    const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);

    const harness: LearnerStoreContractHarness = {
      name: "PgStorage",

      async setup(): Promise<Storage> {
        const storage = PgStorage.create({
          connectionString: pgUrl(),
          migrationsDir: MIGRATIONS_DIR,
        });
        await storage.init();
        await storage.pgPool().query(TRUNCATE_SQL);
        return storage;
      },

      async teardown(storage: Storage): Promise<void> {
        await storage.close();
      },

      async ensureTeam(storage: Storage, teamId: string): Promise<void> {
        await (storage as PgStorage)
          .pgPool()
          .query("INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [teamId, teamId]);
      },
    };

    runLearnerStoreContract(harness);
  },
);
