/**
 * pg-fact-ingest.pg.test.ts
 *
 * Verifies the two correctness fixes from NLM #351 on the pg ingest path:
 *  1. Intra-batch duplicate (subject,predicate) must not create a mutual
 *     supersedence cycle; last-in-batch wins.
 *  2. Ghost embeddings of newly-superseded facts must be deleted from
 *     fact_embeddings so they don't pollute the ANN index.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import { runChecksOnPg } from "../../src/core/integrity/check-invariants.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";

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

describe.skipIf(!PG_TEST_URL)("pg fact ingest correctness (#351 parity)", () => {
  let storage: PgStorage;
  let pool: Pool;

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
    // Seed the session rows required by the facts FK.
    await storage.sessions.insertSessionForTest(makeSession({ id: "s0" }));
    await storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
  });

  it("intra-batch duplicate (subject,predicate) does not create a mutual supersedence cycle", async () => {
    // Two facts, same (subject, predicate), one batch. Winner = last in batch.
    const a = makeFact({ id: "f_a", subject: "svc", predicate: "framework", value: "Fastify", sourceSessionId: "s1" });
    const b = makeFact({ id: "f_b", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
    await storage.facts.ingestSessionFacts("s1", [a, b]);
    const rows = (await pool.query(
      "SELECT id, superseded_by FROM facts WHERE subject = 'svc' ORDER BY id",
    )).rows;
    // f_a superseded by f_b; f_b active. NOT f_a<->f_b mutual.
    expect(rows).toEqual([
      { id: "f_a", superseded_by: "f_b" },
      { id: "f_b", superseded_by: null },
    ]);
  });

  it("collapse deletes embeddings of newly superseded facts", async () => {
    const prior = makeFact({ id: "f_old", subject: "svc", predicate: "framework", value: "Express", sourceSessionId: "s0" });
    await storage.facts.ingestSessionFacts("s0", [prior]);
    await storage.facts.upsertEmbedding("f_old", new Float32Array(768).fill(0.1));
    const next = makeFact({ id: "f_new", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
    await storage.facts.ingestSessionFacts("s1", [next]);
    const emb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = 'f_old'")).rows;
    expect(emb).toHaveLength(0); // ghost embedding must leave the ANN index
    const oldRow = (await pool.query("SELECT superseded_by FROM facts WHERE id = 'f_old'")).rows[0];
    expect(oldRow.superseded_by).toBe("f_new");
  });

  it("re-ingest of the same session is idempotent and leaves one active fact", async () => {
    const f1 = makeFact({ id: "f_1", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
    await storage.facts.ingestSessionFacts("s1", [f1]);
    const f1b = makeFact({ id: "f_1b", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
    await storage.facts.ingestSessionFacts("s1", [f1b]);
    const active = (await pool.query(
      "SELECT id FROM facts WHERE subject = 'svc' AND superseded_by IS NULL",
    )).rows;
    expect(active).toEqual([{ id: "f_1b" }]);
  });

  it("insertSession: intra-batch (subject,predicate) duplicate yields no ghost embedding and I7 clean", async () => {
    const embedder = new StubEmbedder();
    const record = {
      id: "sess_dup_pg",
      runtime: "claude-code",
      runtimeSessionId: null,
      startedAt: "2026-05-19T10:00:00Z",
      endedAt: "2026-05-19T10:30:00Z",
      durationMin: 30,
      label: "L",
      summary: "S",
      body: "",
      status: "closed" as const,
      transcriptKind: "claude-code-jsonl" as const,
      transcriptPath: null,
      transcriptOffset: null,
      transcriptLength: null,
      entities: [],
      decisions: [],
      openQuestions: [],
    };
    const fLoser = makeFact({ id: "pg_dup_loser", subject: "db", predicate: "engine", value: "pg", sourceSessionId: "sess_dup_pg" });
    const fWinner = makeFact({ id: "pg_dup_winner", subject: "db", predicate: "engine", value: "sqlite", sourceSessionId: "sess_dup_pg" });
    await storage.sessions.insertSession(record, embedder, null, {
      factStore: storage.facts,
      facts: [fLoser, fWinner],
    });

    const loserEmb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = $1", ["pg_dup_loser"])).rows;
    const winnerEmb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = $1", ["pg_dup_winner"])).rows;
    expect(loserEmb).toHaveLength(0);
    expect(winnerEmb).toHaveLength(1);
    expect((await runChecksOnPg(pool)).find((v) => v.id === "I7")).toBeUndefined();
  });

  it("insertFactsForSession: intra-batch (subject,predicate) duplicate yields no ghost embedding and I7 clean", async () => {
    const embedder = new StubEmbedder();
    const fLoser = makeFact({ id: "pg_bkfl_loser", subject: "orm", predicate: "lib", value: "Prisma", sourceSessionId: "s1" });
    const fWinner = makeFact({ id: "pg_bkfl_winner", subject: "orm", predicate: "lib", value: "Drizzle", sourceSessionId: "s1" });
    await storage.sessions.insertFactsForSession("s1", storage.facts, [fLoser, fWinner], embedder);

    const loserEmb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = $1", ["pg_bkfl_loser"])).rows;
    const winnerEmb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = $1", ["pg_bkfl_winner"])).rows;
    expect(loserEmb).toHaveLength(0);
    expect(winnerEmb).toHaveLength(1);
    expect((await runChecksOnPg(pool)).find((v) => v.id === "I7")).toBeUndefined();
  });
});
