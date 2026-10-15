/**
 * T732 / E1: a failed or shed fact embedding is recorded as pending and
 * repaired by the daemon sweep; the missing share is measured and alarmed.
 * Real SQLite + sqlite-vec; a stub LLMClient stands in for the embedder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { sweepFactEmbeddings } from "../../src/core/facts/embed-sweep.js";
import { runFactEmbedTick, resetFactEmbedTickForTests } from "../../src/core/facts/embed-sweep-tick.js";
import { computeFactEmbedStats } from "../../src/core/facts/embed-missing.js";
import { runChecksOnSqlite } from "../../src/core/integrity/check-invariants.js";
import { inflightSnapshot, release, tryAcquire, resetForTests as resetInflight } from "../../src/core/health/embed-inflight.js";
import { factEmbedSnapshot, resetFactEmbedStateForTests } from "../../src/core/health/fact-embed-state.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import type { AlertEvent } from "../../src/core/alerts/types.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function vec(seed: number): Float32Array {
  const v = new Float32Array(768);
  v[seed % 768] = 1;
  return v;
}

class StubEmbedder {
  calls = 0;
  failing = false;
  async embed(_text: string, _role: string): Promise<{ vector: Float32Array; dim: number }> {
    this.calls += 1;
    if (this.failing) throw new LLMUnreachableError("embedder unreachable");
    return { vector: vec(this.calls), dim: 768 };
  }
}

describe("fact embedding drop -> pending -> sweep", () => {
  let dir: string;
  let storage: SqliteStorage;
  const embedder = new StubEmbedder();
  const later = () => new Date(Date.now() + 7 * 3_600_000);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-fact-sweep-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "cc_test_1" }));
    embedder.calls = 0;
    embedder.failing = false;
    resetInflight();
    resetFactEmbedStateForTests();
    resetFactEmbedTickForTests();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const pendingRows = () =>
    storage.rawDb().prepare("SELECT fact_id, attempts, last_error FROM fact_embed_pending").all() as Array<{
      fact_id: string;
      attempts: number;
      last_error: string;
    }>;

  const ingest = (facts: ReturnType<typeof makeFact>[]) =>
    storage.sessions.insertFactsForSession(DEFAULT_TEAM_ID, "cc_test_1", storage.facts, facts, embedder as never);

  it("embedder throws on ingest: fact is recorded pending, then the sweep repairs it", async () => {
    embedder.failing = true;
    await ingest([makeFact({ id: "f1", subject: "beacon", predicate: "uses", value: "duckdb" })]);

    expect(computeFactEmbedStats(storage.rawDb()).missing).toBe(1);
    expect(pendingRows()).toMatchObject([{ fact_id: "f1", attempts: 1 }]);

    // inside the backoff window nothing is retried
    const early = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never });
    expect(early.attempted).toBe(0);

    embedder.failing = false;
    const fixed = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never, now: later });
    expect(fixed).toMatchObject({ attempted: 1, repaired: 1, failed: 0, shed: false });
    expect(computeFactEmbedStats(storage.rawDb()).missing).toBe(0);
    expect(pendingRows()).toEqual([]);

    const again = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never, now: later });
    expect(again.attempted).toBe(0);
  });

  it("a failing retry increases attempts and pushes the next try out", async () => {
    embedder.failing = true;
    await ingest([makeFact({ id: "f1" })]);
    const r = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never, now: later });
    expect(r).toMatchObject({ attempted: 1, repaired: 0, failed: 1 });
    expect(pendingRows()[0]?.attempts).toBe(2);
    const next = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never, now: later });
    expect(next.attempted).toBe(0);
  });

  it("shed at the in-flight cap on ingest: recorded pending, repaired once capacity returns", async () => {
    const { cap } = inflightSnapshot();
    for (let i = 0; i < cap; i++) expect(tryAcquire()).toBe(true);
    await ingest([makeFact({ id: "f1", subject: "a", predicate: "p" }), makeFact({ id: "f2", subject: "b", predicate: "p" })]);
    expect(embedder.calls).toBe(0);
    expect(pendingRows().map((r) => r.fact_id).sort()).toEqual(["f1", "f2"]);
    expect(pendingRows()[0]?.last_error).toMatch(/shed/);
    for (let i = 0; i < cap; i++) release();

    const fixed = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never, now: later });
    expect(fixed.repaired).toBe(2);
    expect(computeFactEmbedStats(storage.rawDb()).missing).toBe(0);
  });

  it("the sweep never exceeds the cap: saturated means shed, nothing embedded, nothing failed", async () => {
    await storage.facts.insertMany(DEFAULT_TEAM_ID, [makeFact({ id: "f1" })]);
    const { cap } = inflightSnapshot();
    for (let i = 0; i < cap; i++) tryAcquire();
    const r = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never });
    expect(r).toMatchObject({ attempted: 0, repaired: 0, failed: 0, shed: true });
    expect(embedder.calls).toBe(0);
    expect(inflightSnapshot().current).toBe(cap);
  });

  it("an unrecorded drop (no pending row) is found by absence and repaired", async () => {
    await storage.facts.insertMany(DEFAULT_TEAM_ID, [makeFact({ id: "f1" })]);
    const r = await sweepFactEmbeddings({ tenantId: DEFAULT_TEAM_ID, store: storage.facts, embedder: embedder as never });
    expect(r.repaired).toBe(1);
    expect(inflightSnapshot().current).toBe(0);
  });

  describe("doctor I8 threshold", () => {
    async function seed(total: number, missing: number): Promise<void> {
      const facts = Array.from({ length: total }, (_, i) => makeFact({ id: `f${i}`, subject: `s${i}`, predicate: "p" }));
      await storage.facts.insertMany(DEFAULT_TEAM_ID, facts);
      for (let i = missing; i < total; i++) await storage.facts.upsertEmbedding(DEFAULT_TEAM_ID, `f${i}`, vec(i));
    }
    const i8 = () => runChecksOnSqlite(storage.rawDb()).find((v) => v.id === "I8");

    it("passes at 0.4% missing", async () => {
      await seed(250, 1);
      expect(i8()).toBeUndefined();
    });

    it("fails above 0.5% and reports count and samples", async () => {
      await seed(100, 1);
      expect(i8()).toMatchObject({ count: 1, sampleIds: ["f0"] });
    });
  });

  describe("tick: metric and alarm", () => {
    it("publishes the share and alerts once on the rising edge, re-arming after recovery", async () => {
      await storage.facts.insertMany(DEFAULT_TEAM_ID, [makeFact({ id: "f1" })]);
      const fired: AlertEvent[] = [];
      const deps = { tenantId: DEFAULT_TEAM_ID, storage, embedder: embedder as never, fire: async (e: AlertEvent) => void fired.push(e) };

      embedder.failing = true;
      await runFactEmbedTick(deps);
      await runFactEmbedTick({ ...deps, now: later });
      expect(factEmbedSnapshot()).toMatchObject({ missing: 1, active: 1, missingShare: 1, alarm: true });
      expect(fired.map((e) => e.type)).toEqual(["nlm.facts.embedding_drop"]);

      embedder.failing = false;
      await runFactEmbedTick({ ...deps, now: () => new Date(Date.now() + 14 * 3_600_000) });
      expect(factEmbedSnapshot()).toMatchObject({ missing: 0, alarm: false });
      expect(fired).toHaveLength(1);
    });
  });
});
