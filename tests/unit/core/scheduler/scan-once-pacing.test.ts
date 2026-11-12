/**
 * T1757 Part 3 — the per-source scan loop.
 *
 * `scheduler-tick took 166164ms (sync slice 5750.8ms)` in the live log. Wall
 * time is the classify calls and blocks nothing; the 5.75 s slice is this loop:
 * for a file that has not changed, the body is `statSync` + a Map lookup + a
 * `continue`, i.e. pure synchronous work, and there were thousands of those with
 * no yield between them. The loop now hands the event loop a turn every
 * `SCAN_BATCH_SOURCES` sources.
 *
 * What may not change is *what a scan returns*. Results are compared against the
 * same scan run with the batching effectively disabled, so a chunk list, its
 * order, and the `supersedes`/`resumed` decisions are pinned, not just the count.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import {
  recordClassified,
  scanOnce,
  SCAN_BATCH_SOURCES,
  type ScanPacing,
} from "../../../../src/core/scheduler/scan-once.js";
import type { TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS = resolve(__dirname, "../../../../migrations");
/** Minutes; every fixture file is backdated past this unless stated otherwise. */
const IDLE_MINUTES = 15;

function backdate(path: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

/** Adapter over a fixed list of files. Parses to a chunk for every third source
 *  and to `null` for the rest (the `recordSkipped` branch), so the outcome mixes
 *  returned chunks, skipped files and untouched state rows. */
function listAdapter(paths: string[]): TranscriptAdapter {
  return {
    name: "claude-code",
    discover: async () => paths,
    parseSession: async (sourcePath: string) => {
      const n = Number(/s(\d+)\.jsonl$/.exec(sourcePath)?.[1] ?? -1);
      if (n % 3 !== 0) return null;
      return {
        id: `sess_${n}`,
        runtime: "claude-code",
        runtimeSessionId: `sess_${n}`,
        sourcePath,
        startedAt: "2026-11-11T10:00:00Z",
        endedAt: "2026-11-11T10:30:00Z",
        durationMin: 30,
        turnCount: 1,
        byteRange: [0, 10] as const,
        projectDir: "project_a",
        gitBranch: "main",
        text: "stub body",
        label: "",
      };
    },
  } as unknown as TranscriptAdapter;
}

describe("scanOnce pacing", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let db: Database.Database;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-scan-pacing-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "t.db"), migrationsDir: MIGRATIONS });
    await storage.init();
    db = storage.sessions.rawDb();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** `count` idle files, named s00…sNN so the adapter can branch on the index. */
  function corpus(count: number): string[] {
    return Array.from({ length: count }, (_, i) => {
      const path = join(tmp, `s${String(i).padStart(2, "0")}.jsonl`);
      writeFileSync(path, `{"n":${i}}\n`);
      backdate(path, 60 * 60_000);
      return path;
    });
  }

  function summarise(
    results: ReadonlyArray<{ chunk: { id: string }; supersedes: string | null; resumed: boolean; fileSize: number }>,
  ) {
    return results.map((r) => [r.chunk.id, r.supersedes, r.resumed, r.fileSize]);
  }

  it("batches the loop and returns the same scan in the same order", async () => {
    const paths = corpus(11);
    /** Two sources already ingested at a stale size → RESUMED branch (both are
     *  sources this adapter parses, so they reach the result list), one of them
     *  past the failure ceiling so the reset `UPDATE` runs inside the loop.
     *  Re-seeded before each run: a scan writes `adapter_state`, so the two runs
     *  have to start from identical state for the comparison to mean anything. */
    const seed = () => {
      db.prepare("DELETE FROM adapter_state").run();
      recordClassified(db, "claude-code", paths[3]!, "sess_prev_3", 99_999);
      recordClassified(db, "claude-code", paths[6]!, "sess_prev_6", 99_999);
      db.prepare("UPDATE adapter_state SET failure_count = 5 WHERE source_path = ?").run(paths[6]!);
    };

    seed();
    const unbatched = await scanOnce(listAdapter(paths), IDLE_MINUTES, db, Date.now(), () => {}, {
      yieldEverySources: 1_000_000,
    });
    expect(unbatched.length).toBeGreaterThan(1);
    expect(unbatched.some((r) => r.resumed && r.supersedes === "sess_prev_3")).toBe(true);

    seed();
    let yields = 0;
    const pacing: ScanPacing = {
      yieldEverySources: 3,
      yieldFn: async () => {
        yields += 1;
      },
    };
    const batched = await scanOnce(listAdapter(paths), IDLE_MINUTES, db, Date.now(), () => {}, pacing);
    expect(summarise(batched)).toEqual(summarise(unbatched));
    // 11 sources, 3 per batch → hand-offs before index 3, 6 and 9.
    expect(yields).toBe(3);
    // The reset `UPDATE` really ran, in the batched run as well as the other.
    expect(
      db.prepare<[string], { c: number }>("SELECT failure_count AS c FROM adapter_state WHERE source_path = ?").get(
        paths[6]!,
      )?.c,
    ).toBe(0);
  });

  it("still hands the loop over when every source exits early", async () => {
    // Fresh (under the idle gate) sources take a `continue` on the first line —
    // the reason the yield sits at the top of the iteration, not the bottom.
    const paths = corpus(7);
    for (const p of paths) backdate(p, 60_000);
    let yields = 0;
    const results = await scanOnce(listAdapter(paths), IDLE_MINUTES, db, Date.now(), () => {}, {
      yieldEverySources: 2,
      yieldFn: async () => {
        yields += 1;
      },
    });
    expect(results).toEqual([]);
    expect(yields).toBe(3);
  });

  it("batches with the default too, not only when told to", async () => {
    expect(SCAN_BATCH_SOURCES).toBeGreaterThan(0);
    expect(SCAN_BATCH_SOURCES).toBeLessThan(1_000);
    const paths = corpus(SCAN_BATCH_SOURCES + 5);
    let yields = 0;
    await scanOnce(listAdapter(paths), IDLE_MINUTES, db, Date.now(), () => {}, {
      yieldFn: async () => {
        yields += 1;
    },
    });
    // Only the `yieldEverySources` default is under test here: one hand-off for
    // the sources past the first default batch, and none after the last one.
    expect(yields).toBe(1);
  });

  it("names the adapter_state read in its own [loop] sync line", async () => {
    const lines: string[] = [];
    await scanOnce(listAdapter(corpus(2)), IDLE_MINUTES, db, Date.now(), () => {}, {
      loopLogger: (m) => lines.push(m),
      loopThresholdMs: 0,
    });
    expect(lines.filter((l) => /^\[loop\] sync scan:adapter_state:claude-code \d+(\.\d+)?ms$/.test(l))).toHaveLength(
      1,
    );
  });

  it("stays silent when loop measurement is off", async () => {
    const lines: string[] = [];
    await scanOnce(listAdapter(corpus(2)), IDLE_MINUTES, db, Date.now(), () => {}, {
      loopLogger: (m) => lines.push(m),
      loopThresholdMs: 10_000,
    });
    expect(lines).toEqual([]);
  });
});
