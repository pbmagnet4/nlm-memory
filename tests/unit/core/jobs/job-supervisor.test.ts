/**
 * Unit tests for JobSupervisor (src/core/jobs/job-supervisor.ts) — pure
 * core, so everything here runs against a fake spawner + a virtual-time
 * fake clock. No real child_process, no real timers.
 */

import { describe, expect, it } from "vitest";
import {
  JobSupervisor,
  type ChildHandle,
  type Clock,
  type JobSupervisorEvent,
  type JobState,
  type SpawnChild,
} from "../../../../src/core/jobs/job-supervisor.js";

class FakeChild implements ChildHandle {
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  killed = false;

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    this.killed = true;
  }

  emitLine(line: string): void {
    this.lineCb?.(line);
  }

  emitExit(code: number | null): void {
    this.exitCb?.(code);
  }
}

function fakeSpawner(children: FakeChild[]): SpawnChild {
  return (_args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
}

interface ScheduledInterval {
  readonly fn: () => void;
  readonly ms: number;
  nextAt: number;
}

/** Virtual-time clock: advance(ms) fires any due setInterval callbacks in
 *  chronological order, repeatedly rescheduling them, exactly like a real
 *  interval would over that span — but with zero wall-clock cost. */
class FakeClock implements Clock {
  private currentMs = 0;
  private readonly intervals: ScheduledInterval[] = [];

  now(): number {
    return this.currentMs;
  }

  setInterval(fn: () => void, ms: number): void {
    this.intervals.push({ fn, ms, nextAt: this.currentMs + ms });
  }

  advance(ms: number): void {
    const target = this.currentMs + ms;
    for (;;) {
      let due: ScheduledInterval | null = null;
      for (const iv of this.intervals) {
        if (iv.nextAt <= target && (due === null || iv.nextAt < due.nextAt)) due = iv;
      }
      if (!due) break;
      this.currentMs = due.nextAt;
      due.nextAt += due.ms;
      due.fn();
    }
    this.currentMs = target;
  }
}

function noopLog(): void {}

describe("JobSupervisor", () => {
  it("normal completion: progress to total, clean exit -> completed, no restart, no event", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      log: noopLog,
    });

    sup.start(["--verbose"]);
    expect(children).toHaveLength(1);
    expect(sup.snapshot().state).toBe("running");

    children[0]!.emitLine("  [1/2] sess_a  ok");
    children[0]!.emitLine("  [2/2] sess_b  ok");
    expect(sup.snapshot()).toMatchObject({ processed: 2, total: 2 });

    children[0]!.emitExit(0);

    expect(sup.snapshot().state).toBe("completed");
    expect(children).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("exit with work remaining respawns with the same args", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      log: noopLog,
    });

    sup.start(["--verbose", "--limit", "100"]);
    children[0]!.emitLine("  [1/5] sess_a  ok");
    children[0]!.emitExit(137); // OOM-kill style non-zero exit, work remains (1 < 5)

    expect(children).toHaveLength(2);
    expect(sup.snapshot()).toMatchObject({ state: "running", restarts: 1, processed: 1, total: 5 });
  });

  it("3 consecutive no-progress restarts exhaust the cap: 4 total spawns, no 5th", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      log: noopLog,
    });

    sup.start(["--verbose"]);
    // Initial spawn, then 3 restarts without progress: 1 + 3 = 4 total spawns.
    children[0]!.emitExit(1);
    expect(children).toHaveLength(2);
    children[1]!.emitExit(1);
    expect(children).toHaveLength(3);
    children[2]!.emitExit(1);
    expect(children).toHaveLength(4);

    // Fourth exit with still no progress exceeds the cap (restarts would be 4).
    children[3]!.emitExit(1);

    expect(children).toHaveLength(4); // no 5th spawn
    expect(sup.snapshot().state).toBe("exhausted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "exhausted", restarts: 4, processed: 0, total: 0 });
  });

  it("progress resets the no-progress restart counter", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      log: noopLog,
    });

    sup.start(["--verbose"]);
    children[0]!.emitExit(1); // restarts=1 -> spawn #2
    children[1]!.emitExit(1); // restarts=2 -> spawn #3
    expect(children).toHaveLength(3);
    expect(sup.snapshot().restarts).toBe(2);

    children[2]!.emitLine("  [1/9] sess_a  ok"); // advance -> restarts reset to 0
    expect(sup.snapshot().restarts).toBe(0);

    // 3 more no-progress restarts should now be needed to exhaust, not 1.
    children[2]!.emitExit(1); // restarts=1 -> spawn #4
    children[3]!.emitExit(1); // restarts=2 -> spawn #5
    children[4]!.emitExit(1); // restarts=3 -> spawn #6
    expect(children).toHaveLength(6);
    expect(sup.snapshot().state).toBe("running");
    expect(events).toEqual([]);

    children[5]!.emitExit(1); // restarts=4 > 3 -> exhausted
    expect(children).toHaveLength(6);
    expect(sup.snapshot().state).toBe("exhausted");
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("exhausted");
  });

  it("stall fires once per episode and can fire again after a later stall", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      stallMinutes: 1, // 60_000ms
      stallCheckIntervalMs: 30_000,
      log: noopLog,
    });

    sup.start(["--verbose"]);
    children[0]!.emitLine("  [1/10] sess_a  ok");

    // Advance past the 60s stall window with no further progress.
    clock.advance(90_000);
    expect(sup.snapshot().state).toBe("stalled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "stalled", processed: 1, total: 10 });

    // Further ticks with still no progress must NOT re-fire within the same episode.
    clock.advance(90_000);
    expect(events).toHaveLength(1);

    // A new advance ends the episode and returns to running.
    children[0]!.emitLine("  [2/10] sess_b  ok");
    expect(sup.snapshot().state).toBe("running");

    // A later stall (new episode) fires again.
    clock.advance(90_000);
    expect(sup.snapshot().state).toBe("stalled");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "stalled", processed: 2, total: 10 });
  });

  it("stop() kills the active child, transitions to stopped, and ignores the resulting exit", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      log: noopLog,
    });

    sup.start(["--verbose"]);
    sup.stop();

    expect(children[0]!.killed).toBe(true);
    expect(sup.snapshot().state).toBe("stopped");

    // A real child_process still delivers its exit event after being killed;
    // that must not be reinterpreted as "work remaining" and respawned.
    children[0]!.emitExit(null);
    expect(sup.snapshot().state).toBe("stopped");
    expect(children).toHaveLength(1);
    expect(events).toEqual([]);

    // Idempotent: stopping again (or with no active child) is a no-op.
    sup.stop();
    expect(sup.snapshot().state).toBe("stopped");
  });

  it("snapshot has the full health-block shape in every state", () => {
    const shapeKeys = ["name", "state", "processed", "total", "startedAt", "lastAdvanceAt", "restarts"].sort();
    function assertShape(state: JobState, snap: ReturnType<JobSupervisor["snapshot"]>): void {
      expect(Object.keys(snap).sort()).toEqual(shapeKeys);
      expect(snap.name).toBe("reprocess");
      expect(snap.state).toBe(state);
      expect(typeof snap.processed).toBe("number");
      expect(typeof snap.total).toBe("number");
      expect(typeof snap.restarts).toBe("number");
    }

    // idle
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const events: JobSupervisorEvent[] = [];
    const sup = new JobSupervisor({
      spawnChild: fakeSpawner(children),
      clock,
      onEvent: (e) => events.push(e),
      stallMinutes: 1,
      stallCheckIntervalMs: 30_000,
      log: noopLog,
    });
    assertShape("idle", sup.snapshot());
    expect(sup.snapshot().startedAt).toBeNull();
    expect(sup.snapshot().lastAdvanceAt).toBeNull();

    // running
    sup.start(["--verbose"]);
    assertShape("running", sup.snapshot());
    expect(sup.snapshot().startedAt).not.toBeNull();

    // stalled
    clock.advance(90_000);
    assertShape("stalled", sup.snapshot());

    // stopped
    sup.stop();
    assertShape("stopped", sup.snapshot());

    // completed (fresh run)
    const sup2 = new JobSupervisor({ spawnChild: fakeSpawner(children), clock: new FakeClock(), log: noopLog });
    sup2.start(["--verbose"]);
    const lastChild = children[children.length - 1]!;
    lastChild.emitLine("  [1/1] sess_a  ok");
    lastChild.emitExit(0);
    assertShape("completed", sup2.snapshot());

    // exhausted
    const sup3 = new JobSupervisor({ spawnChild: fakeSpawner(children), clock: new FakeClock(), log: noopLog });
    sup3.start(["--verbose"]);
    for (let i = 0; i < 4; i++) {
      children[children.length - 1]!.emitExit(1);
    }
    assertShape("exhausted", sup3.snapshot());
  });

  it("start() refuses to launch a second concurrent run", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const sup = new JobSupervisor({ spawnChild: fakeSpawner(children), clock, log: noopLog });

    sup.start(["--verbose"]);
    expect(() => sup.start(["--verbose"])).toThrow();
    expect(children).toHaveLength(1);
  });
});
