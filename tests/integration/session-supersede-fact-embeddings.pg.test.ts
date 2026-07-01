/**
 * Task 4 -- session markSuperseded must delete embeddings of newly superseded facts (PG).
 *
 * PG mirror of session-supersede-fact-embeddings.test.ts. Requires a running
 * PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { makeFact } from "../fixtures/facts.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

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

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: "sess_test",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "L",
    summary: "S",
    body: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    ...overrides,
  };
}

describe.skipIf(!PG_TEST_URL)(
  "session markSuperseded cascade -- embedding cleanup (pg)",
  () => {
    let storage: PgStorage;
    let pool: Pool;

    async function embeddingExists(factId: string): Promise<boolean> {
      const r = await pool.query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = $1",
        [factId],
      );
      return Number(r.rows[0]?.c ?? 0) > 0;
    }

    beforeAll(async () => {
      storage = PgStorage.create({
        connectionString: PG_TEST_URL!,
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
      pool = storage.pgPool();
    });

    afterAll(async () => {
      await storage.close();
    });

    beforeEach(async () => {
      await pool.query(TRUNCATE_SQL);
    });

    it("session markSuperseded cascade deletes embeddings of newly superseded facts", async () => {
      // Session A: fact (svc, framework) = Express, embedded.
      const fA = makeFact({
        id: "f_a",
        subject: "svc",
        predicate: "framework",
        value: "Express",
        sourceSessionId: "sess_a",
      });
      await storage.sessions.insertSession(
        makeRecord({ id: "sess_a" }),
        null,
        null,
        { factStore: storage.facts, facts: [fA] },
      );
      await storage.facts.upsertEmbedding("f_a", new Float32Array(768).fill(0.1));
      expect(await embeddingExists("f_a")).toBe(true);

      // Session B: fact (svc, framework) = Hono, active.
      // Insert the session row via insertSession (not insertSessionForTest), then
      // insert the fact directly to avoid triggering ingest-time supersedence so
      // f_a still has its embedding when markSuperseded is called.
      await storage.sessions.insertSession(makeRecord({ id: "sess_b" }));
      const fB = makeFact({
        id: "f_b",
        subject: "svc",
        predicate: "framework",
        value: "Hono",
        sourceSessionId: "sess_b",
      });
      await storage.facts.insert(fB);

      // f_a must still be active and embedded at this point.
      expect((await storage.facts.getById("f_a"))?.supersededBy).toBeNull();
      expect(await embeddingExists("f_a")).toBe(true);

      await storage.sessions.markSuperseded("sess_a", "sess_b");

      expect((await storage.facts.getById("f_a"))?.supersededBy).toBe("f_b");
      expect(await embeddingExists("f_a")).toBe(false);
    });

    it("predecessor fact with no matching successor keeps its embedding and stays active", async () => {
      // Session A: fact (svc, framework) = Express, embedded.
      const fA = makeFact({
        id: "f_a",
        subject: "svc",
        predicate: "framework",
        value: "Express",
        sourceSessionId: "sess_a",
      });
      await storage.sessions.insertSession(
        makeRecord({ id: "sess_a" }),
        null,
        null,
        { factStore: storage.facts, facts: [fA] },
      );
      await storage.facts.upsertEmbedding("f_a", new Float32Array(768).fill(0.1));

      // Session B: fact with a DIFFERENT predicate -- no (svc, framework) match.
      await storage.sessions.insertSession(makeRecord({ id: "sess_b" }));
      const fB = makeFact({
        id: "f_b",
        subject: "svc",
        predicate: "endpoint",
        value: ":3940",
        sourceSessionId: "sess_b",
      });
      await storage.facts.insert(fB);

      await storage.sessions.markSuperseded("sess_a", "sess_b");

      // f_a has no matching successor so it must remain active with its embedding.
      expect((await storage.facts.getById("f_a"))?.supersededBy).toBeNull();
      expect(await embeddingExists("f_a")).toBe(true);
    });
  },
);
