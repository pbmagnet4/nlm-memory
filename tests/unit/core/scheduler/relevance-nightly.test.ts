/**
 * T1782 Part 2 (scheduler side): the nightly relevance judge is *fired*, never
 * awaited. The job is minutes of network time, so the properties that matter are
 * about when it starts and what it may not do: off by default, at most once per
 * 24 h (counted from the attempt, not the success), behind the disk guard, one at
 * a time, and never able to block or break a tick.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";

const DAY = 24 * 60 * 60_000;
const ENV_KEYS = ["NLM_RELEVANCE_STATE", "NLM_INTEGRITY_CACHE"] as const;

let tmp: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-rel-tick-"));
  prev = {};
  for (const k of ENV_KEYS) {
    prev[k] = process.env[k];
    process.env[k] = join(tmp, `${k}.json`);
  }
  // Pre-stamp the cheap-integrity cache so the 24 h integrity pass (which wants
  // a real SQLite handle) never fires in these ticks.
  writeFileSync(process.env["NLM_INTEGRITY_CACHE"]!, JSON.stringify({ checkedAt: new Date().toISOString() }), "utf8");
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** The tick only needs a store to pick its SQLite/PG branch and to discover
 *  adapters; none of the relevance path touches it. */
function makeScheduler(opts: {
  enabled?: boolean;
  run?: () => Promise<unknown>;
  diskGuard?: { shouldSkip(job: string): Promise<boolean> };
  logger?: (m: string) => void;
}) {
  return new ScanScheduler({
    store: { rawDb: () => null } as never,
    adapters: [],
    classifier: { embed: async () => null, classify: async () => null, rewriteForRecall: async () => "", nameWorkstream: async () => null } as never,
    embedder: null,
    idleMinutes: 0,
    logger: opts.logger ?? (() => {}),
    ...(opts.diskGuard ? { diskGuard: opts.diskGuard } : {}),
    ...(opts.run
      ? { relevanceNightly: { enabled: () => opts.enabled !== false, run: opts.run } }
      : {}),
  });
}

const flush = () => new Promise((r) => setImmediate(r));

function marker(): { attemptedAt: string } {
  return JSON.parse(readFileSync(process.env["NLM_RELEVANCE_STATE"]!, "utf8")) as { attemptedAt: string };
}

describe("ScanScheduler nightly relevance judge", () => {
  it("costs nothing and fires nothing when the job is not wired or is off", async () => {
    const asked: string[] = [];
    const guard = { shouldSkip: async (job: string) => { asked.push(job); return false; } };
    await makeScheduler({ diskGuard: guard }).tick();
    await makeScheduler({ enabled: false, run: async () => {}, diskGuard: guard }).tick();
    await flush();
    expect(asked).toEqual(["scheduler-tick", "scheduler-tick"]);
    expect(() => readFileSync(process.env["NLM_RELEVANCE_STATE"]!, "utf8")).toThrow();
  });

  it("fires without blocking the tick, once per night, behind the disk guard", async () => {
    let running = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const jobs: string[] = [];
    let starts = 0;
    const scheduler = makeScheduler({
      diskGuard: { shouldSkip: async (job) => { jobs.push(job); return false; } },
      run: async () => {
        starts += 1;
        running = true;
        await gate;
        running = false;
      },
    });

    // null until the tick's promise resolves; the report is incidental.
    let tickDone: number | null = null;
    const tick = scheduler.tick().then((report) => {
      tickDone = report.inserted;
      return report;
    });
    await flush();
    // The tick is already back while the judge is still in flight — it waits on
    // nothing, which is the whole point of firing rather than awaiting.
    expect(tickDone).toBe(0);
    expect(starts).toBe(1);
    expect(running).toBe(true);
    expect(jobs).toContain("relevance-nightly");

    // A second tick while it runs starts nothing — the run outlives the tick.
    await scheduler.tick();
    await flush();
    expect(starts).toBe(1);

    release();
    await tick;
    await flush();
    expect(running).toBe(false);

    // And the attempt marker holds the next ticks off for the rest of the night.
    await scheduler.tick();
    await flush();
    expect(starts).toBe(1);
    expect(Date.now() - Date.parse(marker().attemptedAt)).toBeLessThan(60_000);
  });

  it("runs again once the marker is a day old", async () => {
    const yesterday = new Date(Date.now() - DAY - 1000).toISOString();
    writeFileSync(process.env["NLM_RELEVANCE_STATE"]!, JSON.stringify({ attemptedAt: yesterday }), "utf8");
    let starts = 0;
    const scheduler = makeScheduler({ run: async () => { starts += 1; } });
    await scheduler.tick();
    await flush();
    expect(starts).toBe(1);
    expect(Date.parse(marker().attemptedAt) - Date.parse(yesterday)).toBeGreaterThan(86_000_000);
  });

  it("asks the disk guard under its own job name and stays home when tripped", async () => {
    const jobs: string[] = [];
    let starts = 0;
    await makeScheduler({
      // Clear for the ingest tick, tripped for this job: the guard is per-job.
      diskGuard: { shouldSkip: async (job) => { jobs.push(job); return job === "relevance-nightly"; } },
      run: async () => { starts += 1; },
    }).tick();
    await flush();
    expect(jobs).toEqual(["scheduler-tick", "relevance-nightly"]);
    expect(starts).toBe(0);
    // The attempt still counts: near a full disk this retries daily, not per tick.
    expect(marker().attemptedAt).toBeTruthy();
  });

  it("does not even start when the ingest tick was already gated off", async () => {
    let starts = 0;
    await makeScheduler({
      diskGuard: { shouldSkip: async () => true },
      run: async () => { starts += 1; },
    }).tick();
    await flush();
    expect(starts).toBe(0);
    expect(() => readFileSync(process.env["NLM_RELEVANCE_STATE"]!, "utf8")).toThrow();
  });

  it("a job that rejects is one log line and leaves no latch stuck", async () => {
    const lines: string[] = [];
    let starts = 0;
    const scheduler = makeScheduler({
      logger: (m) => lines.push(m),
      run: async () => {
        starts += 1;
        throw new Error("store read blew up");
      },
    });
    await scheduler.tick();
    await flush();
    // The tick's own dream-pass lines are noise here; the judge adds exactly one.
    const rel = lines.filter((l) => l.includes("[relevance]"));
    expect(rel).toHaveLength(1);
    expect(rel[0]).toContain("[relevance] WARN");
    expect(rel[0]).toContain("store read blew up");
    expect(starts).toBe(1);

    // The latch is clear, so tomorrow's night can still run: drop the marker and
    // tick again.
    writeFileSync(process.env["NLM_RELEVANCE_STATE"]!, JSON.stringify({ attemptedAt: new Date(Date.now() - DAY - 1).toISOString() }), "utf8");
    await scheduler.tick();
    await flush();
    expect(starts).toBe(2);
  });
});
