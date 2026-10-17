import { describe } from "vitest";
import { resolve } from "node:path";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";
import { runScopedSemanticRecallContract } from "../contract/scoped-semantic-recall.contract.js";

const url = process.env["NLM_PG_TEST_URL"];
describe.skipIf(!url)("Postgres eligible semantic recall", () => {
  const pgUrl = usePgTestSchema(url, import.meta.url);
  runScopedSemanticRecallContract({
    name: "Postgres",
    async setup() {
      const storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: resolve("migrations/pg") });
      await storage.init();
      await storage.pgPool().query("TRUNCATE TABLE sessions, workstreams, teams RESTART IDENTITY CASCADE");
      await storage.pgPool().query("INSERT INTO teams (id, name) VALUES ('team_local', 'Local')");
      return storage;
    },
    async teardown(storage) { await storage.close(); },
    async foreignTeam(storage) {
      await (storage as PgStorage).pgPool().query("INSERT INTO teams (id, name) VALUES ($1, $2)", ["team_foreign", "Foreign"]);
    },
    async seedSession(storage, session, tenantId) {
      await (storage as PgStorage).sessions.insertSessionForTest(session, tenantId);
    },
    async seedChunk(storage, sessionId, chunkIndex, vector, mapped) {
      const pool = (storage as PgStorage).pgPool();
      const result = await pool.query<{ chunk_id: number }>("INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding) VALUES ($1, $2, $3::vector) RETURNING chunk_id", [sessionId, chunkIndex, JSON.stringify(Array.from(vector))]);
      if (mapped) await pool.query("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES ($1, $2, $3)", [result.rows[0]!.chunk_id, sessionId, chunkIndex]);
    },
  });
});
