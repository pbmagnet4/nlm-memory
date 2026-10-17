import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { PgFactStore } from "../../src/core/storage/pg-fact-store.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const baseUrl = process.env["NLM_PG_TEST_URL"];
describe.skipIf(!baseUrl)("current-value summary PostgreSQL snapshots and interruption", () => {
  const pgUrl = usePgTestSchema(baseUrl, import.meta.url);
  let storage: PgStorage;
  const query = { subject: "project", predicate: "database", minConfidence: 0.6 };
  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: resolve(__dirname, "../../migrations/pg") });
    await storage.init();
    await storage.sessions.insertSessionForTest(makeSession({ id: "source" }));
    await storage.facts.insert("team_local", makeFact({ id: "a", sourceSessionId: "source", ...query, value: "A" }));
  });
  afterAll(async () => { await storage?.close(); });

  it("reads counts and previews in one MVCC statement while another transaction commits an alternative", async () => {
    const writer = await storage.pgPool().connect();
    const reader = new Pool({ connectionString: pgUrl(), max: 1 });
    try {
      await writer.query("BEGIN");
      await writer.query(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, created_at, confidence, tenant_id)
        VALUES ('b', 'decision', 'project', 'database', 'B', 'source', NOW(), 0.9, 'team_local')`);
      const store = new PgFactStore(reader);
      const reads = vi.spyOn(reader, "query");
      expect(await store.summarizeCurrentValues("team_local", query)).toEqual({ distinctValueCount: 1, sourceSessionCount: 1,
        examples: [{ value: "A", sourceSessionId: "source" }] });
      expect(reads).toHaveBeenCalledOnce();
      await writer.query("COMMIT");
      reads.mockClear();
      expect(await store.summarizeCurrentValues("team_local", query)).toEqual({ distinctValueCount: 2, sourceSessionCount: 1,
        examples: [{ value: "A", sourceSessionId: "source" }, { value: "B", sourceSessionId: "source" }] });
      expect(reads).toHaveBeenCalledOnce();
    } finally {
      await writer.query("ROLLBACK"); writer.release(); await reader.end();
    }
  });

  it("rejects a server-interrupted aggregate rather than returning a partial count", async () => {
    const writer = await storage.pgPool().connect();
    const reader = new Pool({ connectionString: pgUrl(), max: 1, statement_timeout: 50 });
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE facts IN ACCESS EXCLUSIVE MODE");
      await expect(new PgFactStore(reader).summarizeCurrentValues("team_local", query)).rejects.toMatchObject({ code: "57014" });
    } finally {
      await writer.query("ROLLBACK"); writer.release(); await reader.end();
    }
  });
});
