import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoSweepScheduler, sweepMemoDir } from "../../src/core/hook/memo-sweep.js";

describe("memo sweep", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-sweep-"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function plantMemo(name: string, ageMs: number): string {
    const path = join(tmp, name);
    writeFileSync(path, "[]", "utf8");
    if (ageMs > 0) {
      const past = (Date.now() - ageMs) / 1000;
      utimesSync(path, past, past);
    }
    return path;
  }

  it("returns a zero-count report when state dir does not exist", () => {
    const report = sweepMemoDir({ stateDir: join(tmp, "nope") });
    expect(report).toEqual({ scanned: 0, deleted: 0, kept: 0, errors: 0 });
  });

  it("deletes memos older than the dormant threshold and keeps fresh ones", () => {
    plantMemo("fresh.json", 30 * 60 * 1000); // 30 min old — active
    plantMemo("idle.json", 6 * 60 * 60 * 1000); // 6 hours — idle
    plantMemo("dormant-a.json", 25 * 60 * 60 * 1000); // 25h — dormant
    plantMemo("dormant-b.json", 30 * 24 * 60 * 60 * 1000); // 30 days — very dormant

    const report = sweepMemoDir({ stateDir: tmp });
    expect(report).toMatchObject({ scanned: 4, deleted: 2, kept: 2, errors: 0 });

    const remaining = readdirSync(tmp).sort();
    expect(remaining).toEqual(["fresh.json", "idle.json"]);
  });

  it("ignores non-json files in the state dir", () => {
    plantMemo("dormant.json", 25 * 60 * 60 * 1000);
    writeFileSync(join(tmp, "README.txt"), "not a memo");
    writeFileSync(join(tmp, ".DS_Store"), "");

    const report = sweepMemoDir({ stateDir: tmp });
    expect(report.deleted).toBe(1);
    expect(existsSync(join(tmp, "README.txt"))).toBe(true);
    expect(existsSync(join(tmp, ".DS_Store"))).toBe(true);
  });

  it("honors a custom dormantMs threshold", () => {
    plantMemo("two-hour-old.json", 2 * 60 * 60 * 1000);
    // Threshold of 1 hour — anything older than 1h is dormant.
    const report = sweepMemoDir({ stateDir: tmp, dormantMs: 60 * 60 * 1000 });
    expect(report.deleted).toBe(1);
  });

  it("uses an injected `now` for deterministic time-window tests", () => {
    const path = plantMemo("memo.json", 0);
    // memo was just touched. Pretend "now" is 2 days in the future — it's dormant.
    const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const report = sweepMemoDir({ stateDir: tmp, now: () => future });
    expect(report.deleted).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("MemoSweepScheduler.tick performs the sweep without scheduling", () => {
    plantMemo("dormant.json", 25 * 60 * 60 * 1000);
    plantMemo("fresh.json", 60_000);
    const sweeper = new MemoSweepScheduler({ stateDir: tmp, logger: () => {} });
    const report = sweeper.tick();
    expect(report.deleted).toBe(1);
    expect(report.kept).toBe(1);
  });

  it("MemoSweepScheduler.start does not throw and stop cleans up the timer", () => {
    const sweeper = new MemoSweepScheduler({
      stateDir: tmp,
      intervalMs: 60_000,
      logger: () => {},
    });
    expect(() => sweeper.start()).not.toThrow();
    expect(() => sweeper.stop()).not.toThrow();
    // Idempotent — double-stop is a no-op.
    expect(() => sweeper.stop()).not.toThrow();
  });
});
