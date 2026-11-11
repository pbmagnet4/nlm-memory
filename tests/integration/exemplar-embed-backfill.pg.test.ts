/**
 * backfillExemplarEmbeddingsPg against a real PostgreSQL + pgvector instance.
 * Skips without NLM_PG_TEST_URL (see embed-backfill.pg.test.ts).
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { codeHash } from "../../src/core/exemplars/ingest-exemplar.js";
import { backfillExemplarEmbeddingsPg } from "../../src/core/exemplars/pg-embed-backfill.js";
import type { CodeEmbedder, EmbedCodeResult } from "../../src/ports/code-embedder.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");

class StubCodeEmbedder implements CodeEmbedder {
  calls = 0;
  constructor(private readonly dim: number, private readonly failFromCall = Infinity) {}
  async embed(): Promise<EmbedCodeResult> {
    this.calls += 1;
    if (this.calls >= this.failFromCall) throw new Error("boom");
    const vector = new Float32Array(this.dim);
    vector[this.calls % this.dim] = 1;
    return { vector, dim: this.dim };
  }
}

describe.skipIf(!PG_TEST_URL)("backfillExemplarEmbeddingsPg", () => {
  const pgTestUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgTestUrl(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });

  const run = (embedder: CodeEmbedder, extra: Record<string, unknown> = {}) =>
    backfillExemplarEmbeddingsPg({
      tenantId: "team_local", pool, embedder, store: storage.exemplars,
      provider: "ollama", model: "code-a", onStale: "rebuild", ...extra,
    });
  const dim = async () =>
    (await pool.query<{ d: number }>("SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = 'code_exemplar_embeddings'::regclass AND attname = 'embedding'")).rows[0]!.d;
  const count = async () =>
    Number((await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM code_exemplar_embeddings")).rows[0]!.n);
  const model = async () =>
    (await pool.query<{ model: string }>("SELECT model FROM embedding_config WHERE lane = 'code'")).rows[0]?.model;

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE code_exemplar_embeddings, code_exemplars, embedding_config RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM code_exemplar_embeddings");
    await pool.query("DROP INDEX IF EXISTS code_exemplar_embeddings_idx");
    await pool.query("ALTER TABLE code_exemplar_embeddings ALTER COLUMN embedding TYPE vector(768)");
    for (const c of ["const a = 1;", "const b = 2;", "const c = 3;"]) {
      await storage.exemplars.insert("team_local", {
        installScope: "install-test", signalId: null, sessionId: null, repo: "/r", model: "m", lang: "ts",
        taskContext: c, code: c, codeHash: codeHash(c), outcome: "pass", gitSha: null, survived: null, scope: null,
        ts: "2026-06-15T12:00:00.000Z",
      });
    }
    expect((await run(new StubCodeEmbedder(768))).succeeded).toBe(3);
  });

  it("rebuilds at the new dim, re-embeds every row and records the config", async () => {
    const report = await run(new StubCodeEmbedder(384), { model: "code-b" });
    expect(report).toMatchObject({ rebuilt: true, total: 3, succeeded: 3, failed: 0 });
    expect(await dim()).toBe(384);
    expect(await count()).toBe(3);
    expect(await model()).toBe("code-b");
  });

  it("an interrupted rebuild resumes without clearing again", async () => {
    await expect(run(new StubCodeEmbedder(384, 3), { model: "code-b" })).rejects.toThrow("boom");
    expect(await count()).toBe(1);
    expect(await model()).toBe("code-b");
    const report = await run(new StubCodeEmbedder(384), { model: "code-b" });
    expect(report.rebuilt).toBeUndefined();
    expect(report).toMatchObject({ total: 2, succeeded: 2 });
    expect(await count()).toBe(3);
  });

  it('onStale "skip" and dry-run write nothing', async () => {
    for (const extra of [{ onStale: "skip" }, { dryRun: true }]) {
      const report = await run(new StubCodeEmbedder(384), { model: "code-b", ...extra });
      expect(report.stale).toBe(true);
      expect(await dim()).toBe(768);
      expect(await count()).toBe(3);
      expect(await model()).toBe("code-a");
    }
  });
});
