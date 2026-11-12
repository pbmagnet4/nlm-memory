/**
 * T1772 Part 3: the disk guard. statfs is injected and the clock is fake;
 * everything else is the real decision logic.
 */
import { describe, expect, it } from "vitest";
import {
  createDiskGuard,
  diskThresholds,
  type DiskGuardStatus,
} from "../../../../src/core/health/disk-guard.js";

const GIB = 1024 ** 3;

function statFor({ bsize = 4096, blocks = 1_000_000, free }: { bsize?: number; blocks?: number; free: number }) {
  return async () => ({ bsize, blocks, bavail: Math.floor(free / bsize) });
}

describe("diskThresholds", () => {
  it("defaults to 2% and 5 GiB", () => {
    expect(diskThresholds({})).toEqual({ minFreePct: 2, minFreeGb: 5 });
  });
  it("reads the env knobs, falls back on garbage", () => {
    expect(diskThresholds({ NLM_DISK_MIN_FREE_PCT: "10", NLM_DISK_MIN_FREE_GB: "20" }))
      .toEqual({ minFreePct: 10, minFreeGb: 20 });
    expect(diskThresholds({ NLM_DISK_MIN_FREE_PCT: "abc", NLM_DISK_MIN_FREE_GB: "-1" }))
      .toEqual({ minFreePct: 2, minFreeGb: 5 });
  });
});

describe("createDiskGuard", () => {
  it("trips below the absolute GiB floor and notches the health snapshot", async () => {
    const now = { t: 1_000_000 };
    const logs: string[] = [];
    const guard = createDiskGuard({
      path: "/db/canonical.sqlite",
      logger: (m) => logs.push(m),
      now: () => now.t,
      // total ≈ 3.8 GiB → 2% = 80 MiB, but the 5 GiB absolute floor dominates.
      stat: statFor({ free: 4 * GIB }),
    });
    expect(await guard.shouldSkip("fact-embed-sweep")).toBe(true);
    expect(guard.status()).toMatchObject({ free: Math.floor((4 * GIB) / 4096) * 4096, threshold: 5 * GIB, tripped: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/WARN 4\.0 GiB free, floor 5\.0 GiB.*skipped fact-embed-sweep/);
  });

  it("the percent threshold dominates on volumes where it exceeds the GiB floor", async () => {
    // 2 TiB volume: 2% = 40 GiB > 5 GiB floor. 6 GiB free passes the GiB
    // floor but trips the percent floor.
    const guard = createDiskGuard({
      path: "/db/canonical.sqlite",
      logger: () => {},
      stat: statFor({ bsize: 4096, blocks: Math.round((2 * 1024 * GIB) / 4096), free: 6 * GIB }),
    });
    expect(await guard.shouldSkip("db-backup")).toBe(true);
    const s = guard.status()!;
    expect(s.tripped).toBe(true);
    expect(Math.round(s.threshold / GIB)).toBe(41); // 2% of 2048 GiB = 40.96
  });

  it("passes when free space is above both floors", async () => {
    const guard = createDiskGuard({
      path: "/db/canonical.sqlite",
      logger: () => {},
      stat: statFor({ free: 6 * GIB }),
    });
    expect(await guard.shouldSkip("chunk-embed-sweep")).toBe(false);
    expect(guard.status()!.tripped).toBe(false);
  });

  it("WARNs at most once per hour across jobs, but keeps skipping", async () => {
    const now = { t: 0 };
    const logs: string[] = [];
    const guard = createDiskGuard({
      path: "/x",
      logger: (m) => logs.push(m),
      now: () => now.t,
      stat: statFor({ free: 1 * GIB }),
    });
    expect(await guard.shouldSkip("scheduler-tick")).toBe(true); // WARN #1
    now.t += 60_000;
    expect(await guard.shouldSkip("fact-embed-sweep")).toBe(true); // silent
    now.t += 60 * 60_000; // past the 1h window
    expect(await guard.shouldSkip("db-backup")).toBe(true); // WARN #2
    expect(logs).toHaveLength(2);
  });

  it("status() is null until the first check", () => {
    const guard = createDiskGuard({ path: "/x", stat: statFor({ free: 6 * GIB }) });
    expect(guard.status()).toBeNull();
  });

  it("a failed probe does not block writes; it WARNs within its window", async () => {
    const logs: string[] = [];
    const guard = createDiskGuard({
      path: "/x",
      logger: (m) => logs.push(m),
      stat: async () => { throw new Error("statfs EPERM"); },
    });
    expect(await guard.shouldSkip("scheduler-tick")).toBe(false);
    expect(await guard.shouldSkip("db-backup")).toBe(false); // rate-limited second call
    expect(guard.status()).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("free-space check failed");
  });

  it("health snapshot exposes exactly the {free, threshold, tripped} contract", async () => {
    const guard = createDiskGuard({ path: "/x", stat: statFor({ free: 1 * GIB }) });
    await guard.shouldSkip("db-backup");
    const s = guard.status() as DiskGuardStatus;
    expect(typeof s.free).toBe("number");
    expect(typeof s.threshold).toBe("number");
    expect(typeof s.tripped).toBe("boolean");
  });
});
