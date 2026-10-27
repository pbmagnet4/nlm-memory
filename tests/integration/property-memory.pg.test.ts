import { describe } from "vitest";
import { resolve } from "node:path";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";
import { runPropertyMemoryContract } from "../contract/property-memory.contract.js";
const url = process.env["NLM_PG_TEST_URL"];
describe.skipIf(!url)("PostgreSQL property memory", () => {
  const pgUrl = usePgTestSchema(url, import.meta.url);
  runPropertyMemoryContract({
    async setup() { const s = PgStorage.create({ connectionString: pgUrl(), migrationsDir: resolve("migrations/pg") }); await s.init(); await s.pgPool().query("TRUNCATE facts, sessions, memory_properties, property_overrides CASCADE"); return s; },
    async close(s) { await s.close(); },
    async attributeSession(s, tenantId, record) { const storage = s as PgStorage; await storage.properties.attributeSession(tenantId, record); },
  async maintain(s, sessionId, facts, embedder) { const storage = s as PgStorage; await storage.sessions.insertFactsForSession("team_local", sessionId, storage.facts, facts, embedder); },
  async ingest(s, record, facts, embedder) { const storage = s as PgStorage; await storage.sessions.insertSession("team_local", record, embedder ?? null, null, { factStore: storage.facts, facts }); },
  });
});
