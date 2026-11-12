/**
 * T1757 Part 3 — the missing-embedding counts, measured before they were bounded.
 *
 * The sweep ran every 2 minutes and reported `[loop] fact-embed-sweep took 2347ms
 * (sync slice 605ms)` on the live corpus. T679 had estimated those three counts at
 * 53-86 ms each and deferred bounding them until the log said whether it was worth
 * it; the log said it was. `computeFactEmbedStatsChunked` walks the same predicates
 * over rowid windows with a yield between them.
 *
 * The bar here is arithmetic: the sums over partitioned windows must equal the
 * single-statement counts, including on a table with retired and superseded facts
 * (not recall-eligible), gaps from deletes, and pending rows — so `active`,
 * `missing`, `pending` and the derived share all have to line up.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import {
  computeFactEmbedStats,
  computeFactEmbedStatsChunked,
  FACT_COUNT_BATCH_ROWS,
} from "../../../../src/core/facts/embed-missing.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";
import { makeFact } from "../../../fixtures/facts.js";
import { makeSession } from "../../../fixtures/sessions.js";

const MIGRATIONS = resolve(__dirname, "../../../../migrations");

function vector(seed: number): Float32Array {
  const v = new Float32Array(768);
  v[seed % 768] = 1;
  return v;
}

/** Embeds successfully on every other call, so the corpus ends up with embedded
 *  facts, missing facts and `fact_embed_pending` rows however the ingest builds its
 *  embedding text. */
class HalfFailingEmbedder {
  private calls = 0;
  async embed(): Promise<{ vector: Float32Array; dim: number }> {
    this.calls += 1;
    if (this.calls % 2 === 1) throw new Error("embedder unreachable");
    return { vector: vector(this.calls), dim: 768 };
  }
}

describe("computeFactEmbedStatsChunked", () => {
  let dir: string;
  let storage: SqliteStorage;
  let embedder: HalfFailingEmbedder;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-fact-counts-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.sqlite"), migrationsDir: MIGRATIONS });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "cc_test_1" }));
    embedder = new HalfFailingEmbedder();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 12 facts (6 embedded, 6 missing+pending), then two retired, one superseded
   *  and one deleted, so `active` is neither the row count nor a lucky subset. */
  async function seed(): Promise<void> {
    const facts = Array.from({ length: 12 }, (_, i) =>
      makeFact({ id: `f${i}`, subject: `subj${i}`, predicate: "uses", value: `val${i}` }),
    );
    await storage.sessions.insertFactsForSession(DEFAULT_TEAM_ID, "cc_test_1", storage.facts, facts, embedder as never);
    const db = storage.rawDb();
    db.prepare("UPDATE facts SET retired_at = datetime('now') WHERE id IN ('f4', 'f6')").run();
    db.prepare("UPDATE facts SET superseded_by = 'f0' WHERE id = 'f8'").run();
    db.prepare("DELETE FROM facts WHERE id = 'f10'").run();
  }

  it("equals the single-statement counts on a mixed corpus", async () => {
    await seed();
    const db = storage.rawDb();
    const oracle = computeFactEmbedStats(db);
    // Sanity: the fixture is not degenerate, or the comparison would prove nothing.
    expect(oracle.active).toBeGreaterThan(0);
    expect(oracle.missing).toBeGreaterThan(0);
    expect(oracle.pending).toBeGreaterThan(0);
    expect(await computeFactEmbedStatsChunked(db)).toEqual(oracle);
  });

  it("equals the single-statement counts one row per window, with a yield between each", async () => {
    await seed();
    const db = storage.rawDb();
    const bounds = db
      .prepare<[], { lo: number; hi: number }>("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM facts")
      .get()!;
    let yields = 0;
    const stats = await computeFactEmbedStatsChunked(db, {
      yieldEveryRows: 1,
      yieldFn: async () => {
        yields += 1;
      },
    });
    expect(stats).toEqual(computeFactEmbedStats(db));
    // One window per rowid in [MIN, MAX] — gaps from the deleted row count as
    // empty windows — and no yield after the last one.
    expect(yields).toBe(bounds.hi - bounds.lo);
    expect(yields).toBeGreaterThan(1);
  });

  it("reports zeros for an empty table without walking anything", async () => {
    let yields = 0;
    expect(
      await computeFactEmbedStatsChunked(storage.rawDb(), {
        yieldEveryRows: 3,
        yieldFn: async () => {
          yields += 1;
        },
      }),
    ).toEqual({ active: 0, missing: 0, pending: 0, missingShare: 0 });
    expect(yields).toBe(0);
  });

  it("names each window it counts in a [loop] sync line", async () => {
    await seed();
    const lines: string[] = [];
    await computeFactEmbedStatsChunked(storage.rawDb(), {
      yieldEveryRows: 2,
      loopLogger: (m) => lines.push(m),
      loopThresholdMs: 0,
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(/^\[loop\] sync fact-embed-sweep:count \d+(\.\d+)?ms$/);
  });

  it("keeps a default small enough to matter", () => {
    expect(FACT_COUNT_BATCH_ROWS).toBeGreaterThan(0);
    expect(FACT_COUNT_BATCH_ROWS).toBeLessThan(50_000);
  });
});
