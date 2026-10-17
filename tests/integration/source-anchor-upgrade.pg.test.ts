import { it } from "vitest";
import { Pool } from "pg";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";
import { verifySourceAnchorUpgrade } from "../helpers/source-anchor-upgrade.js";
const url = process.env["NLM_PG_TEST_URL"];
const pgUrl = usePgTestSchema(url, import.meta.url);
it.skipIf(!url)("upgrades PG038 without hashing or backfilling existing sources/facts", async () => {
  const pool = new Pool({ connectionString: pgUrl() });
  try { await verifySourceAnchorUpgrade(true, (path) => runMigrationsPg(pool, path), async (sql) => (await pool.query(sql)).rows); }
  finally { await pool.end(); }
});
