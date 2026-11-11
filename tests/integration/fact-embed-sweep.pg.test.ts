/**
 * Postgres twin of fact-embed-sweep.test.ts: a failed fact embedding is
 * recorded in fact_embed_pending and repaired by the daemon sweep, and the
 * missing share is measured and alarmed. Requires NLM_PG_TEST_URL; skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { sweepFactEmbeddings } from "../../src/core/facts/embed-sweep.js";
import { runFactEmbedTick, resetFactEmbedTickForTests } from "../../src/core/facts/embed-sweep-tick.js";
import { computeFactEmbedStatsOnPg } from "../../src/core/facts/embed-missing.js";
import { factEmbedSnapshot, resetFactEmbedStateForTests } from "../../src/core/health/fact-embed-state.js";
import { resetForTests as resetInflight } from "../../src/core/health/embed-inflight.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import type { AlertEvent } from "../../src/core/alerts/types.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import { FixedEmbedder, StubEmbedder } from "../fixtures/llm-stubs.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");

describe.skipIf(!PG_TEST_URL)("Postgres fact embedding drop -> pending -> sweep", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;
  const later = () => new Date(Date.now() + 7 * 3_600_000);
  const down = () => new StubEmbedder({ fail: true });

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => {
    await storage.close();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE fact_embed_pending, fact_embeddings, facts, sessions RESTART IDENTITY CASCADE");
    await storage.sessions.insertSessionForTest(makeSession({ id: "cc_test_1" }));
    resetInflight();
    resetFactEmbedStateForTests();
    resetFactEmbedTickForTests();
  });

  const pendingRows = async () =>
    (await pool.query<{ fact_id: string; attempts: number }>("SELECT fact_id, attempts FROM fact_embed_pending")).rows;
  const ingest = (facts: ReturnType<typeof makeFact>[], embedder = down()) =>
    storage.sessions.insertFactsForSession(DEFAULT_TEAM_ID, "cc_test_1", storage.facts, facts, embedder);
  const sweep = (embedder: FixedEmbedder | StubEmbedder, now?: () => Date) =>
    sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder, ...(now ? { now } : {}) });

  it("embedder throws on ingest: fact is recorded pending, backoff holds, then the sweep repairs it", async () => {
    await ingest([makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" })]);
    expect(await computeFactEmbedStatsOnPg(pool)).toMatchObject({ active: 1, missing: 1, pending: 1 });
    expect(await pendingRows()).toMatchObject([{ fact_id: "f1", attempts: 1 }]);

    expect((await sweep(new FixedEmbedder())).attempted).toBe(0);

    const fixed = await sweep(new FixedEmbedder(), later);
    expect(fixed).toMatchObject({ attempted: 1, repaired: 1, failed: 0, shed: false });
    expect(await computeFactEmbedStatsOnPg(pool)).toMatchObject({ missing: 0, pending: 0 });
    expect(await pendingRows()).toEqual([]);
    expect((await sweep(new FixedEmbedder(), later)).attempted).toBe(0);
  });

  it("a failing retry increases attempts and pushes the next try out", async () => {
    await ingest([makeFact({ id: "f1" })]);
    expect(await sweep(down(), later)).toMatchObject({ attempted: 1, repaired: 0, failed: 1 });
    expect((await pendingRows())[0]?.attempts).toBe(2);
    expect((await sweep(new FixedEmbedder(), later)).attempted).toBe(0);
  });

  it("finds a drop that was never recorded as pending", async () => {
    await ingest([makeFact({ id: "f1" })]);
    await pool.query("DELETE FROM fact_embed_pending");
    expect(await sweep(new FixedEmbedder())).toMatchObject({ attempted: 1, repaired: 1 });
  });

  it("tick publishes the share and alerts once on the rising edge, re-arming after recovery", async () => {
    await ingest([makeFact({ id: "f1" })]);
    const fired: AlertEvent[] = [];
    const deps = {
      tenantId: DEFAULT_TEAM_ID,
      store: storage.facts,
      stats: () => computeFactEmbedStatsOnPg(pool),
      embedder: down(),
      fire: async (e: AlertEvent) => void fired.push(e),
    };
    await runFactEmbedTick(deps);
    await runFactEmbedTick({ ...deps, now: later });
    expect(factEmbedSnapshot()).toMatchObject({ missing: 1, active: 1, missingShare: 1, alarm: true });
    expect(fired.map((e) => e.type)).toEqual(["nlm.facts.embedding_drop"]);

    await runFactEmbedTick({ ...deps, embedder: new FixedEmbedder(), now: () => new Date(Date.now() + 14 * 3_600_000) });
    expect(factEmbedSnapshot()).toMatchObject({ missing: 0, alarm: false });
    expect(fired).toHaveLength(1);
  });
});
