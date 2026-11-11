/**
 * T679 Part 1 — the loop-block detector's threshold logic.
 *
 * The two things that must not regress: (1) a job whose synchronous slice
 * crosses the threshold always produces exactly one `[loop] <job> took ..`
 * line, and (2) a job that merely *takes a long time* while awaiting I/O never
 * produces one, since that is normal ingest behaviour and would drown the
 * signal.
 *
 * T1757 Part 1 adds the two pieces that turn "the loop froze" into a fixable
 * bug: the active-job set behind `[loop] stall <ms>ms during: <jobs>`, and
 * `timeSyncSlice`, which names the segment (`[loop] sync <job>:<label> <ms>ms`).
 */

import { describe, expect, it } from "vitest";
import {
  createActiveJobSet,
  createStallAttributor,
  createSyncStopwatch,
  fixedSliceProbe,
  startLoopLagMonitor,
  syncSliceProbe,
  timeJob,
  timeSyncSlice,
  withActiveJob,
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
    expect(samples[0]!.syncSliceMs).toBeGreaterThanOrEqual(140);
    expect(samples[0]!.syncSliceMs).toBeLessThan(400);
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

  it("names the running job as soon as a block crosses the stall threshold", async () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({
      logger,
      autoStart: false,
      resolutionMs: 5,
      stallThresholdMs: 40,
      activeJobs: () => ["scheduler-tick", "alert-health"],
    });
    blockMs(120);
    await sleep(40);
    expect(lines.filter((l) => l.includes("[loop] stall"))).toEqual([
      expect.stringMatching(/^\[loop\] stall \d+(\.\d+)?ms during: scheduler-tick, alert-health$/),
    ]);
    monitor.stop();
  });

  it("can be told not to attribute stalls", async () => {
    const { lines, logger } = capture();
    const monitor = startLoopLagMonitor({
      logger,
      autoStart: false,
      resolutionMs: 5,
      stallThresholdMs: 40,
      stallAttribution: false,
      activeJobs: () => ["scheduler-tick"],
    });
    blockMs(120);
    await sleep(40);
    expect(lines.filter((l) => l.includes("[loop] stall"))).toEqual([]);
    monitor.stop();
  });
});

describe("createActiveJobSet", () => {
  it("tracks enter/exit and keeps first-entered order", () => {
    const set = createActiveJobSet();
    expect(set.active()).toEqual([]);
    const leaveTick = set.enter("scheduler-tick");
    const leaveAlert = set.enter("alert-health");
    expect(set.active()).toEqual(["scheduler-tick", "alert-health"]);
    expect(set.size).toBe(2);
    leaveTick();
    expect(set.active()).toEqual(["alert-health"]);
    leaveAlert();
    expect(set.active()).toEqual([]);
  });

  it("collapses overlapping runs of one name and survives a double release", () => {
    const set = createActiveJobSet();
    const leaveA = set.enter("corpus-monitor");
    const leaveB = set.enter("corpus-monitor");
    expect(set.active()).toEqual(["corpus-monitor x2"]);
    expect(set.size).toBe(2);
    leaveA();
    leaveA(); // a wrapper and its callee both releasing must drop exactly one
    expect(set.active()).toEqual(["corpus-monitor"]);
    expect(set.size).toBe(1);
    leaveB();
    expect(set.active()).toEqual([]);
  });
});

describe("withActiveJob", () => {
  it("is active for the whole job, including after awaits, then released", async () => {
    const set = createActiveJobSet();
    const seen: string[][] = [];
    const out = await withActiveJob(
      "alert-health",
      async () => {
        seen.push([...set.active()]);
        await sleep(1);
        seen.push([...set.active()]);
        return "ok";
      },
      set,
    );
    expect(out).toBe("ok");
    expect(seen).toEqual([["alert-health"], ["alert-health"]]);
    expect(set.active()).toEqual([]);
  });

  it("releases on a synchronous throw", async () => {
    const set = createActiveJobSet();
    await expect(
      withActiveJob(
        "wiki-projection",
        () => {
          throw new Error("disk full");
        },
        set,
      ),
    ).rejects.toThrow("disk full");
    expect(set.active()).toEqual([]);
  });

  it("releases on rejection", async () => {
    const set = createActiveJobSet();
    await expect(
      withActiveJob(
        "fact-embed-sweep",
        () => Promise.reject(new Error("embedder down")),
        set,
      ),
    ).rejects.toThrow("embedder down");
    expect(set.active()).toEqual([]);
  });

  it("releases a fire-and-forget job when its promise settles", async () => {
    const set = createActiveJobSet();
    let done!: () => void;
    const gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    void withActiveJob("corpus-monitor", () => gate, set);
    await sleep(1);
    expect(set.active()).toEqual(["corpus-monitor"]);
    done();
    await sleep(1);
    expect(set.active()).toEqual([]);
  });
});

describe("createStallAttributor", () => {
  const at = (jobs: readonly string[], thresholdMs = 500) => {
    const { lines, logger } = capture();
    return {
      lines,
      attributor: createStallAttributor({ logger, thresholdMs, activeJobs: () => jobs }),
    };
  };

  it("logs the block with the active jobs once it crosses the threshold", () => {
    const { lines, attributor } = at(["scheduler-tick", "alert-health x2"]);
    expect(attributor.observe(499)).toBe(false);
    expect(lines).toEqual([]);
    expect(attributor.observe(501)).toBe(true);
    expect(lines).toEqual(["[loop] stall 501ms during: scheduler-tick, alert-health x2"]);
    expect(attributor.attributedMs).toBe(501);
  });

  it("says so when no tracked job was on the loop", () => {
    const { lines, attributor } = at([]);
    expect(attributor.observe(14_046)).toBe(true);
    expect(lines).toEqual(["[loop] stall 14046ms during: no tracked job"]);
  });

  it("reports only the worst block of a window and re-arms on reset", () => {
    const { lines, attributor } = at(["corpus-monitor"]);
    expect(attributor.observe(1_662)).toBe(true);
    expect(attributor.observe(900)).toBe(false); // quieter than what we already blamed
    expect(attributor.observe(5_504)).toBe(true); // a worse second block
    expect(lines).toHaveLength(2);
    attributor.reset();
    expect(attributor.attributedMs).toBe(0);
    expect(attributor.observe(600)).toBe(true);
    expect(lines).toHaveLength(3);
  });
});

describe("timeSyncSlice", () => {
  it("logs the job and label when the segment crosses the threshold", () => {
    const { lines, logger } = capture();
    let clockMs = 1_000;
    const out = timeSyncSlice(
      "alert-health",
      "adapter_state.all",
      () => {
        clockMs = 1_320;
        return 42;
      },
      { logger, now: () => clockMs },
    );
    expect(out).toBe(42);
    expect(lines).toEqual(["[loop] sync alert-health:adapter_state.all 320ms"]);
  });

  it("stays silent under the threshold and honours a custom one", () => {
    const { lines, logger } = capture();
    let clockMs = 0;
    timeSyncSlice(
      "job",
      "quiet",
      () => {
        clockMs = 249.9;
      },
      { logger, now: () => clockMs },
    );
    expect(lines).toEqual([]);
    clockMs = 0;
    timeSyncSlice(
      "job",
      "loud",
      () => {
        clockMs = 60;
      },
      { logger, now: () => clockMs, thresholdMs: 50 },
    );
    expect(lines).toEqual(["[loop] sync job:loud 60ms"]);
  });

  it("logs and rethrows when the segment throws", () => {
    const { lines, logger } = capture();
    expect(() =>
      timeSyncSlice(
        "corpus-monitor",
        "recompute",
        () => {
          throw new Error("SQLITE_BUSY");
        },
        { logger, thresholdMs: 0 },
      ),
    ).toThrow("SQLITE_BUSY");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[loop] sync corpus-monitor:recompute");
  });

  it("measures a real block when no clock is injected, via the stopwatch", () => {
    const { lines, logger } = capture();
    const watch = createSyncStopwatch("alert-health", { logger, thresholdMs: 40 });
    const values = watch.time("stat-loop", () => {
      blockMs(80);
      return [1, 2, 3];
    });
    expect(values).toHaveLength(3);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[loop\] sync alert-health:stat-loop \d+(\.\d+)?ms$/);
    expect(Number(lines[0]!.match(/(\d+(\.\d+)?)ms$/)?.[1])).toBeGreaterThanOrEqual(70);
  });
});
