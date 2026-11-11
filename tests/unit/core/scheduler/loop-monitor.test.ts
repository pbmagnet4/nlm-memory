/**
 * T679 Part 1 — the loop-block detector's threshold logic.
 *
 * The two things that must not regress: (1) a job whose synchronous slice
 * crosses the threshold always produces exactly one `[loop] <job> took ..`
 * line, and (2) a job that merely *takes a long time* while awaiting I/O never
 * produces one, since that is normal ingest behaviour and would drown the
 * signal.
 */

import { describe, expect, it } from "vitest";
import {
  fixedSliceProbe,
  startLoopLagMonitor,
  syncSliceProbe,
  timeJob,
  type JobSample,
} from "@core/scheduler/loop-monitor.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const blockMs = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* synchronous spin — this is the shape of a better-sqlite3 full scan */
  }
};

function capture() {
  const lines: string[] = [];
  return { lines, logger: (msg: string) => lines.push(msg) };
}

describe("timeJob", () => {
  it("logs the job name and wall time when a sync slice crosses the threshold", async () => {
    const { lines, logger } = capture();
    const out = await timeJob("fact-embed-sweep", async () => "report", {
      logger,
      probe: fixedSliceProbe(900),
      now: () => 1_000,
    });
    expect(out).toBe("report");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[loop\] fact-embed-sweep took \d+(\.\d+)?ms \(sync slice 900ms/);
  });

  it("reports the wall time, not the slice length, in the took= field", async () => {
    const { lines, logger } = capture();
    let t = 0;
    await timeJob("corpus-monitor", async () => {
      t = 1_750;
    }, { logger, probe: fixedSliceProbe(300), now: () => t });
    expect(lines[0]).toContain("corpus-monitor took 1750ms");
  });

  it("stays silent under the threshold but still samples the job", async () => {
    const { lines, logger } = capture();
    const samples: JobSample[] = [];
    await timeJob("wiki-projection", async () => 1, {
      logger,
      probe: fixedSliceProbe(249.9),
      onSample: (s) => samples.push(s),
    });
    expect(lines).toEqual([]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ job: "wiki-projection", logged: false, syncSliceMs: 249.9 });
  });

  it("treats a slice exactly at the threshold as over it", async () => {
    const { lines, logger } = capture();
    await timeJob("job", async () => {}, { logger, probe: fixedSliceProbe(250) });
    expect(lines).toHaveLength(1);
  });

  it("honours a custom threshold", async () => {
    const { lines, logger } = capture();
    await timeJob("job", async () => {}, { logger, probe: fixedSliceProbe(120), thresholdMs: 100 });
    expect(lines).toHaveLength(1);
  });

  it("logs and rethrows when the job fails", async () => {
    const { lines, logger } = capture();
    await expect(
      timeJob("chunk-embed-sweep", async () => {
        throw new Error("embedder down");
      }, { logger, probe: fixedSliceProbe(500) }),
    ).rejects.toThrow("embedder down");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("chunk-embed-sweep took");
  });

  it("measures a synchronous job's own block with the default probe", async () => {
    const { lines, logger } = capture();
    const samples: JobSample[] = [];
    await timeJob("real-block", () => blockMs(160), {
      logger,
      thresholdMs: 40,
      onSample: (s) => samples.push(s),
    });
    expect(lines).toHaveLength(1);
    // The head measurement is the block itself, so the slice lands on it.
    expect(samples[0].syncSliceMs).toBeGreaterThanOrEqual(140);
    expect(samples[0].syncSliceMs).toBeLessThan(400);
  });

  it("measures blocking done after an await (the tail)", async () => {
    const { lines, logger } = capture();
    await timeJob("tail-block", async () => {
      await sleep(30);
      blockMs(160);
      await sleep(30);
    }, { logger, probe: syncSliceProbe(5), thresholdMs: 40 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tail-block took");
  });

  it("does not flag an async job that blocks nothing", async () => {
    const { lines, logger } = capture();
    await timeJob("awaits-only", async () => {
      await sleep(80);
    }, { logger, probe: syncSliceProbe(5), thresholdMs: 40 });
    expect(lines).toEqual([]);
  });

  it("reads its probe without consuming it, then once only on stop", () => {
    const p = fixedSliceProbe(400)();
    expect(p.read()).toBe(400);
    expect(p.read()).toBe(400);
    expect(p.stop()).toBe(400);
    expect(p.stop()).toBe(0);
    expect(p.read()).toBe(0);
  });

});

describe("startLoopLagMonitor", () => {
  it("reports nothing before the sampler has seen a timer firing", () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({ logger, autoStart: false });
    expect(monitor.snapshot()).toBeNull();
    expect(monitor.report()).toBeNull();
    expect(lines).toEqual([]);
    monitor.stop();
  });

  it("logs a p99 line and resets the window after reporting", async () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({ logger, autoStart: false, resolutionMs: 10 });
    blockMs(120);
    await sleep(30);
    const snap = monitor.report();
    expect(snap).not.toBeNull();
    expect(snap!.maxMs).toBeGreaterThan(20);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[loop\] lag p99=\d+(\.\d+)?ms \(p50=\d+(\.\d+)?ms max=\d+(\.\d+)?ms window=\d+s\)$/);
    // Window reset: a quiet follow-up report sees no samples again.
    expect(monitor.report()).toBeNull();
    expect(lines).toHaveLength(1);
    monitor.stop();
  });

  it("leaves the window untouched when snapshotting", () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({ logger, autoStart: false, resolutionMs: 10 });
    expect(monitor.snapshot()).toBeNull();
    expect(lines).toEqual([]);
    monitor.stop();
  });

  it("reports on the timer without being asked", async () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({ logger, reportIntervalMs: 20, resolutionMs: 10 });
    blockMs(60);
    await sleep(80);
    expect(lines.some((l) => l.startsWith("[loop] lag p99="))).toBe(true);
    monitor.stop();
    expect(monitor.snapshot()).toBeNull();
  });
});
