/**
 * Integration tests for reembedCorpusPg against a real PostgreSQL + pgvector
 * instance. No network: a deterministic fake LLMClient stands in for Ollama.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL, e.g.:
 *   export NLM_PG_TEST_URL=postgres://postgres:nlm@127.0.0.1:5544/nlm_test
 *
 * Each top-level describe gets its own isolated pg schema (pg-test-schema
 * helper) in beforeAll and drops it in afterAll. This prevents afterEach
 * schema mutations (ALTER TABLE for dim changes) from leaking the
 * degenerate-centroid ivfflat state to other test files.
 *
 * Skips when the env var is absent.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { reembedCorpusPg } from "../../src/core/embedding/pg-embed-backfill.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { makeSession } from "../fixtures/sessions.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

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
    entities, sources, providers, adapter_state, actions,
    embedding_config
  RESTART IDENTITY CASCADE
`;

class DeterministicEmbedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls += 1;
    const v = new Float32Array(768);
    v[0] = this.calls;
    const sum = Array.from(v).reduce((a, x) => a + x * x, 0);
    const n = Math.sqrt(sum) || 1;
    const out = new Float32Array(768);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
    return { vector: out, model: "fake-768" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used"); }
}

class Dim8Embedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls++;
    const v = new Float32Array(8);
    v[this.calls % 8] = 1;
    return { vector: v, model: "stub-8d" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used"); }
}

const seedSessions = [
  makeSession({ id: "s_a", label: "Hono setup", body: "wired Hono routes" }),
  makeSession({ id: "s_b", label: "pgvector plan", body: "drafted pgvector swap" }),
  makeSession({ id: "s_c", label: "tx tax county", body: "ingested county directory" }),
];

describe.skipIf(!PG_TEST_URL)("reembedCorpusPg", () => {
  const pgTestUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;
  let dbUrl: string;
  let tmp: string;
  let statePath: string;

  beforeAll(async () => {
    dbUrl = pgTestUrl();
    storage = PgStorage.create({ connectionString: dbUrl, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    for (const s of seedSessions) {
      await storage.sessions.insertSessionForTest(s);
    }
    tmp = mkdtempSync(join(tmpdir(), "nlm-pg-emb-"));
    statePath = join(tmp, "state.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("embeds all sessions and writes a state file", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpusPg({ pgUrl: dbUrl, embedder, statePath });

    expect(report.dbMissing).toBe(false);
    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.skippedAlreadyDone).toBe(0);
    // 1 probe + 3 session chunks (one chunk per short session)
    expect(embedder.calls).toBe(4);
    expect(existsSync(statePath)).toBe(true);

    const { rows } = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM session_embedding_chunks",
    );
    expect(Number(rows[0]?.cnt)).toBe(3);
  });

  it("is resumable: second run skips ids already in state", async () => {
    const embedder1 = new DeterministicEmbedder();
    await reembedCorpusPg({ pgUrl: dbUrl, embedder: embedder1, statePath });

    const embedder2 = new DeterministicEmbedder();
    const report = await reembedCorpusPg({ pgUrl: dbUrl, embedder: embedder2, statePath });

    expect(report.skippedAlreadyDone).toBe(3);
    expect(report.succeeded).toBe(0);
    // Only the probe call fires; all sessions are already in the state file
    expect(embedder2.calls).toBe(1);
  });

  it("respects --limit", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpusPg({ pgUrl: dbUrl, embedder, statePath, limit: 2 });
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });
});

describe.skipIf(!PG_TEST_URL)("reembedCorpusPg rebuild on dim mismatch", () => {
  const pgTestUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;
  let dbUrl: string;
  let tmp: string;
  let statePath: string;

  beforeAll(async () => {
    dbUrl = pgTestUrl();
    storage = PgStorage.create({ connectionString: dbUrl, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    for (const s of seedSessions) {
      await storage.sessions.insertSessionForTest(s);
    }
    // Seed a 768-dim config row and a fact with a 768-dim embedding
    await pool.query(
      "INSERT INTO embedding_config (lane, provider, model, dim, updated_at) VALUES ($1, $2, $3, $4, $5)",
      ["prose", "test", "model-768", 768, new Date().toISOString()],
    );
    await pool.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["f_1", "attribute", "project", "uses", "SQLite", "s_a", 0.9],
    );
    const vec768 = `[${new Array(768).fill(0.1).join(",")}]`;
    await pool.query(
      "INSERT INTO fact_embeddings (fact_id, embedding) VALUES ($1, $2::vector)",
      ["f_1", vec768],
    );
    tmp = mkdtempSync(join(tmpdir(), "nlm-pg-rebuild-"));
    statePath = join(tmp, "state.json");
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    // Restore vector columns to 768-dim so the next beforeEach can seed 768-dim vectors.
    // This is safe: the isolated DB is not shared with other test files.
    await pool.query("DELETE FROM fact_embeddings");
    await pool.query("DROP INDEX IF EXISTS fact_embeddings_idx");
    await pool.query("ALTER TABLE fact_embeddings ALTER COLUMN embedding TYPE vector(768)");
    await pool.query(
      "CREATE INDEX IF NOT EXISTS fact_embeddings_idx" +
      " ON fact_embeddings USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)",
    );
    await pool.query("DELETE FROM session_embedding_chunks");
    await pool.query("DROP INDEX IF EXISTS session_chunks_embedding_idx");
    await pool.query(
      "ALTER TABLE session_embedding_chunks ALTER COLUMN embedding TYPE vector(768)",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS session_chunks_embedding_idx" +
      " ON session_embedding_chunks USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)",
    );
  });

  it("alters column to new dim and reembeds sessions and facts", async () => {
    const embedder = new Dim8Embedder();
    const report = await reembedCorpusPg({
      pgUrl: dbUrl,
      embedder,
      statePath,
      embedderProvider: "test",
    });

    expect(report.rebuilt).toBe(true);
    expect(report.succeeded).toBe(3);
    expect(report.factsReembedded).toBe(1);

    // atttypmod for vector(8) should be 8
    const dimRow = await pool.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'session_embedding_chunks'::regclass AND attname = 'embedding'`,
    );
    expect(dimRow.rows[0]?.atttypmod).toBe(8);

    const factDimRow = await pool.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'fact_embeddings'::regclass AND attname = 'embedding'`,
    );
    expect(factDimRow.rows[0]?.atttypmod).toBe(8);

    // Config row updated to dim=8
    const cfgRow = await pool.query<{ dim: number; model: string; provider: string }>(
      "SELECT dim, model, provider FROM embedding_config WHERE lane = 'prose'",
    );
    expect(cfgRow.rows[0]?.dim).toBe(8);
    expect(cfgRow.rows[0]?.model).toBe("stub-8d");
    expect(cfgRow.rows[0]?.provider).toBe("test");

    // Verify round-trip: vectors in DB have 8 components
    const chunkRow = await pool.query<{ embedding: string }>(
      "SELECT embedding::text FROM session_embedding_chunks LIMIT 1",
    );
    const embText = chunkRow.rows[0]?.embedding ?? "";
    const components = embText.replace(/[[\]]/g, "").split(",").filter(Boolean);
    expect(components).toHaveLength(8);
  });

  it("preserves chunks on same-config rerun, no rebuild", async () => {
    const embedder1 = new Dim8Embedder();
    await reembedCorpusPg({
      pgUrl: dbUrl,
      embedder: embedder1,
      statePath,
      embedderProvider: "test",
    });

    const { rows: afterRebuild } = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM session_chunk_map",
    );
    expect(Number(afterRebuild[0]?.cnt)).toBe(3);

    const embedder2 = new Dim8Embedder();
    const report = await reembedCorpusPg({
      pgUrl: dbUrl,
      embedder: embedder2,
      statePath,
      embedderProvider: "test",
    });

    expect(report.rebuilt).toBe(false);
    expect(report.skippedAlreadyDone).toBe(3);
    expect(report.factsReembedded).toBe(0);

    const { rows: afterSecond } = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM session_chunk_map",
    );
    expect(Number(afterSecond[0]?.cnt)).toBe(3);

    const { rows: factRows } = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM fact_embeddings",
    );
    expect(Number(factRows[0]?.cnt)).toBe(1);
  });
});
