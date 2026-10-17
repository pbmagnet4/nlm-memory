import { describe } from "vitest";
import { resolve } from "node:path";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";
import { runSourceAnchorContract } from "../contract/source-anchor.contract.js";
const url = process.env["NLM_PG_TEST_URL"];
const pgUrl = usePgTestSchema(url, import.meta.url);
const migrationsDir = resolve("migrations/pg");
describe.skipIf(!url)("Postgres anchors", () => runSourceAnchorContract({
  async setup() { const s = PgStorage.create({ connectionString: pgUrl(), migrationsDir }); await s.init(); await s.pgPool().query("TRUNCATE sessions, facts, teams CASCADE"); await s.pgPool().query("INSERT INTO teams(id, name) VALUES ('team_local', 'Local')"); return s; },
  async close(s) { await s.close(); },
  async sql(s, sql, params = []) { let n = 0; return (await (s as PgStorage).pgPool().query(sql.replace(/\?/g, () => `$${++n}`), params)).rows; },
  async ingest(s, record, facts) { const storage = s as PgStorage; await storage.sessions.insertSession("team_local", record, null, null, facts ? { factStore: storage.facts, facts } : null); },
  async maintain(s, facts) { const storage = s as PgStorage; await storage.sessions.insertFactsForSession("team_local", "anchor-session", storage.facts, facts); },
  async migrate(s) { return [...await runMigrationsPg((s as PgStorage).pgPool(), migrationsDir)]; },
}));
