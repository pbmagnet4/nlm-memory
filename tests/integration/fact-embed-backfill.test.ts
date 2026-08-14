/**
 * Integration tests for the fact embed-backfill against a real SQLite +
 * sqlite-vec store. No network: a deterministic stub LLMClient stands in for
 * the embedder.
 *
 * Models the production failure (#435): `embedFacts` swallows per-fact embed
 * errors, so a transient embedder blip leaves an active fact permanently
 * absent from fact_embeddings — keyword-recallable but invisible to semantic
 * recall, with nothing that ever repairs it. The backfill discovers those
 * rows, embeds them with the same text shape the live ingest path uses, and
 * upserts. A second run is a no-op.
 *
 * Recall-ineligible facts (superseded / retired) are deliberately NOT
 * embedded: repair-fact-embeddings.mjs exists to DELETE their ghost vectors,
 * so re-embedding them here would fight that repair and reintroduce the
 * ghosts #351 removed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { backfillFactEmbeddings } from "../../src/core/facts/embed-backfill.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import type { Fact } from "../../src/shared/types.js";
import type { FactStore } from "../../src/ports/fact-store.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unitWithLeading(value: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = value;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(768);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

/** Records the exact text it was asked to embed so the test can assert parity with the live path. */
class StubEmbedder {
  calls = 0;
  seen: string[] = [];
  failFirstN = 0;

  async embed(text: string, _role: string): Promise<{ vector: Float32Array; dim: number }> {
    this.calls += 1;
    this.seen.push(text);
    if (this.calls <= this.failFirstN) {
      throw new LLMUnreachableError("embedder blip");
    }
    const vector = unitWithLeading(this.calls);
    return { vector, dim: vector.length };
  }
}

describe("fact embed-backfill", () => {
  let dir: string;
  let dbPath: string;
  let storage: SqliteStorage;
  let factStore: FactStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-fact-backfill-"));
    dbPath = join(dir, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    factStore = storage.facts;
    storage.sessions.insertSessionForTest(makeSession({ id: "cc_test_1" }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(facts: ReadonlyArray<Fact>): Promise<void> {
    await factStore.insertMany(DEFAULT_TEAM_ID, facts);
  }

  function countMissing(): number {
    const db = storage.rawDb();
    return (
      db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM facts f
           WHERE f.superseded_by IS NULL AND f.retired_at IS NULL
             AND f.id NOT IN (SELECT fact_id FROM fact_embeddings)`,
        )
        .get()?.n ?? -1
    );
  }

  it("embeds active facts that have no vector, and is a no-op on a second run", async () => {
    await seed([
      makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" }),
      makeFact({ id: "f2", subject: "beacon", predicate: "port", value: "8080" }),
    ]);
    expect(countMissing()).toBe(2);

    const embedder = new StubEmbedder();
    const first = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });

    expect(first.total).toBe(2);
    expect(first.succeeded).toBe(2);
    expect(first.failed).toBe(0);
    expect(countMissing()).toBe(0);

    const second = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });
    expect(second.total).toBe(0);
    expect(second.succeeded).toBe(0);
  });

  it("embeds the same text shape as the live ingest path", async () => {
    await seed([makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" })]);

    const embedder = new StubEmbedder();
    await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });

    // sqlite-session-store.embedFacts: `${subject} ${predicate} ${value}`.trim()
    expect(embedder.seen).toEqual(["beacon uses duckdb"]);
  });

  it("skips superseded and retired facts", async () => {
    await seed([
      makeFact({ id: "f_live", subject: "beacon", predicate: "uses", value: "duckdb" }),
      makeFact({ id: "f_new", subject: "beacon", predicate: "store", value: "sqlite" }),
      makeFact({ id: "f_old", subject: "beacon", predicate: "store", value: "postgres" }),
    ]);
    await factStore.markSuperseded(DEFAULT_TEAM_ID, "f_old", "f_new");
    await factStore.retire(DEFAULT_TEAM_ID, "f_new");

    const embedder = new StubEmbedder();
    const report = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });

    expect(report.total).toBe(1);
    expect(embedder.seen).toEqual(["beacon uses duckdb"]);
  });

  it("retries once on a transient embedder failure", async () => {
    await seed([makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" })]);

    const embedder = new StubEmbedder();
    embedder.failFirstN = 1;

    const report = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });

    expect(embedder.calls).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(countMissing()).toBe(0);
  });

  it("counts a persistently failing fact as failed without aborting the run", async () => {
    await seed([
      makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" }),
      makeFact({ id: "f2", subject: "beacon", predicate: "port", value: "8080" }),
    ]);

    const embedder = new StubEmbedder();
    embedder.failFirstN = 2; // both attempts for f1 fail; f2 then succeeds

    const report = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath,
      embedder: embedder as never,
      store: factStore,
    });

    expect(report.total).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.succeeded).toBe(1);
    expect(countMissing()).toBe(1);
  });

  it("reports dbMissing for a nonexistent database", async () => {
    const report = await backfillFactEmbeddings({
      tenantId: DEFAULT_TEAM_ID,
      dbPath: join(dir, "nope.sqlite"),
      embedder: new StubEmbedder() as never,
      store: factStore,
    });
    expect(report.dbMissing).toBe(true);
    expect(report.total).toBe(0);
  });
});
