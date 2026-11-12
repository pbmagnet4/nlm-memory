/**
 * T1772 (review fix): the daemon's exemplar embed-backfill opens the live
 * store read-write (vector upserts per missing row, plus the rebuild path),
 * so — like db-backup, fact-embed-sweep and chunk-embed-sweep — it must ask
 * the disk guard before touching it. The guard's contract: tripped means the
 * sweep never opens the store; clear (or the guard's own probe failing open)
 * means the sweep behaves exactly as ungated.
 */
import { describe, expect, it } from "vitest";
import { runExemplarBackfillTick } from "../../../src/cli/nlm.js";

describe("runExemplarBackfillTick disk guard", () => {
  it("tripped guard: one gate call, store never opened, nothing logged", async () => {
    const seen: string[] = [];
    let opened = 0;
    const logs: string[] = [];
    await runExemplarBackfillTick({
      diskGuard: {
        shouldSkip: async (job) => {
          seen.push(job);
          return true;
        },
      },
      backfill: async () => {
        opened += 1;
        return { total: 0, succeeded: 0, failed: 0 };
      },
      logger: (m) => logs.push(m),
    });
    expect(seen).toEqual(["exemplar-backfill"]);
    expect(opened).toBe(0);
    expect(logs).toEqual([]);
  });

  it("clear guard: sweep runs once and reports repairs", async () => {
    const logs: string[] = [];
    let opened = 0;
    await runExemplarBackfillTick({
      diskGuard: { shouldSkip: async () => false },
      backfill: async () => {
        opened += 1;
        return { total: 3, succeeded: 2, failed: 1 };
      },
      logger: (m) => logs.push(m),
    });
    expect(opened).toBe(1);
    expect(logs).toEqual(["[exemplar-backfill] 2/3 repaired (1 failed)"]);
  });

  it("a quiet report logs nothing; a throw stays one log line (daemon tick must not crash)", async () => {
    const logs: string[] = [];
    await runExemplarBackfillTick({
      diskGuard: { shouldSkip: async () => false },
      backfill: async () => ({ total: 0, succeeded: 0, failed: 0 }),
      logger: (m) => logs.push(m),
    });
    expect(logs).toEqual([]);

    await runExemplarBackfillTick({
      diskGuard: { shouldSkip: async () => false },
      backfill: async () => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
      logger: (m) => logs.push(m),
    });
    expect(logs).toEqual(["[exemplar-backfill] error: SQLITE_FULL: database or disk is full"]);
  });
});
