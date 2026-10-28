/**
 * Postgres twin of chunk-embed-retry.test.ts: failed chunks are enqueued and
 * swept, the vector + map pair is one transaction, and `doctor --fix` removes
 * map-less vectors (I7b-1). Requires NLM_PG_TEST_URL; skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { MAX_CHUNK_EMBED_ATTEMPTS, stuckChunksOnPg, sweepChunkEmbeddings } from "../../src/core/embedding/chunk-retry.js";
import { applyFixOnPg } from "../../src/core/integrity/check-invariants.js";
import { resetForTests as resetInflight } from "../../src/core/health/embed-inflight.js";
import { StubEmbedder, FixedEmbedder } from "../fixtures/llm-stubs.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");
const TENANT = "team_local";

function makeRecord(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: null,
    startedAt: "2026-10-01T00:00:00Z",
    endedAt: "2026-10-01T00:05:00Z",
    durationMin: 5,
    label: "L",
    summary: "S",
    body: "a short body that makes exactly one chunk",
    status: "closed",
    transcriptKind: null,
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe.skipIf(!PG_TEST_URL)("Postgres chunk embed retry", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;
  const later = (hours: number) => () => new Date(Date.now() + hours * 3_600_000);
  const count = async (table: string) =>
    Number((await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    resetInflight();
    await pool.query("TRUNCATE TABLE session_chunk_map, session_embedding_chunks, chunk_embed_pending, sessions RESTART IDENTITY CASCADE");
  });

  it("a failing map insert rolls the vector back", async () => {
    await expect(storage.sessions.insertChunkEmbedding("ghost-session", 0, new Float32Array(768))).rejects.toThrow();
    expect(await count("session_embedding_chunks")).toBe(0);
  });

  it("embedder down: chunk enqueued, swept on recovery, capped at 5 attempts", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("s1"), new StubEmbedder({ fail: true }));
    expect(await count("session_embedding_chunks")).toBe(0);
    expect(await count("chunk_embed_pending")).toBe(1);

    const down = new StubEmbedder({ fail: true });
    for (let i = 1; i < MAX_CHUNK_EMBED_ATTEMPTS; i++) {
      expect(await sweepChunkEmbeddings({ store: storage.sessions, embedder: down, now: later(24 * i) })).toMatchObject({ attempted: 1, failed: 1 });
    }
    expect(await stuckChunksOnPg(pool)).toMatchObject([{ sessionId: "s1", chunkIdx: 0, attempts: MAX_CHUNK_EMBED_ATTEMPTS }]);
    expect(await sweepChunkEmbeddings({ store: storage.sessions, embedder: new FixedEmbedder(), now: later(24 * 10) })).toMatchObject({ attempted: 0 });

    await pool.query("UPDATE chunk_embed_pending SET attempts = 1");
    const ok = await sweepChunkEmbeddings({ store: storage.sessions, embedder: new FixedEmbedder(), now: later(24 * 10) });
    expect(ok).toMatchObject({ attempted: 1, repaired: 1 });
    expect(await count("session_embedding_chunks")).toBe(1);
    expect(await count("session_chunk_map")).toBe(1);
    expect(await count("chunk_embed_pending")).toBe(0);
  });

  it("doctor --fix deletes map-less chunk vectors and keeps mapped ones", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("s1"), new FixedEmbedder());
    const orphan = await pool.query<{ chunk_id: number }>(
      `INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding)
       VALUES ('s1', 7, $1::vector) RETURNING chunk_id`,
      [`[${new Array(768).fill(0).join(",")}]`],
    );
    const report = await applyFixOnPg(pool);
    expect(report.deletedOrphanChunkIds).toEqual([orphan.rows[0]!.chunk_id]);
    expect(await count("session_embedding_chunks")).toBe(1);
    expect((await applyFixOnPg(pool)).deletedOrphanChunkIds).toEqual([]);
  });
});
