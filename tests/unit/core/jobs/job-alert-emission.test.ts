/**
 * End-to-end alert emission: JobSupervisor's onEvent wired to
 * fireAlert(buildJobAlertEvent(event)) — the exact composition the daemon
 * (src/cli/nlm.ts's `start` command) performs. Drives a real JobSupervisor
 * with a fake spawner + virtual-time clock into a stall and an exhaustion,
 * and asserts the resulting webhook POST carries the `nlm.job.stalled`
 * envelope with the right reason. Same fetchImpl-stubbing style as
 * tests/unit/core/alerts/fire-alert.test.ts — no real network.
 */

import { describe, expect, it } from "vitest";
import { JobSupervisor, type JobSupervisorEvent } from "../../../../src/core/jobs/job-supervisor.js";
import { buildJobAlertEvent } from "../../../../src/core/alerts/job-alert.js";
import { fireAlert } from "../../../../src/core/alerts/fire-alert.js";
import type { ChildHandle, SpawnChild } from "../../../../src/ports/spawn-child.js";
import type { Clock } from "../../../../src/ports/clock.js";

class FakeChild implements ChildHandle {
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  killed = false;
  onLine(cb: (line: string) => void): void { this.lineCb = cb; }
  onExit(cb: (code: number | null) => void): void { this.exitCb = cb; }
  kill(): void { this.killed = true; }
  emitLine(line: string): void { this.lineCb?.(line); }
  emitExit(code: number | null): void { this.exitCb?.(code); }
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

class FakeClock implements Clock {
  private currentMs = 0;
  private intervals: ScheduledInterval[] = [];
  now(): number { return this.currentMs; }
  setInterval(fn: () => void, ms: number): void {
    this.intervals.push({ fn, ms, nextAt: this.currentMs + ms });
  }
  advance(ms: number): void {
    const target = this.currentMs + ms;
    while (true) {
      const due = this.intervals
        .filter((i) => i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!due) break;
      this.currentMs = due.nextAt;
      due.nextAt += due.ms;
      due.fn();
    }
    this.currentMs = target;
  }
}

function fakeFetch(posts: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

describe("JobSupervisor onEvent -> fireAlert(buildJobAlertEvent(...)) wiring", () => {
  const WEBHOOK = "https://example.test/hook";

  it("POSTs an nlm.job.stalled envelope with reason 'stalled' on a stall", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = WEBHOOK;
    try {
      const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = fakeFetch(posts);
      const children: FakeChild[] = [];
      const clock = new FakeClock();
      const events: JobSupervisorEvent[] = [];

      const supervisor = new JobSupervisor({
        spawnChild: fakeSpawner(children),
        clock,
        stallMinutes: 20,
        onEvent: (event) => {
          events.push(event);
          void fireAlert(buildJobAlertEvent(event), { fetchImpl });
        },
      });

      supervisor.start(["--limit", "10"]);
      children[0]!.emitLine("  [5/50] sess_1  ok");
      clock.advance(21 * 60_000);

      // fireAlert is fire-and-forget from onEvent; flush microtasks.
      await new Promise((r) => setTimeout(r, 0));

      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("stalled");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body["type"]).toBe("nlm.job.stalled");
      const data = posts[0]!.body["data"] as Record<string, unknown>;
      expect(data["job"]).toBe("reprocess");
      expect(data["reason"]).toBe("stalled");
      expect(data["processed"]).toBe(5);
      expect(data["total"]).toBe(50);
      expect(typeof data["message"]).toBe("string");
    } finally {
      delete process.env["NLM_ALERT_WEBHOOK"];
    }
  });

  it("POSTs an nlm.job.stalled envelope with reason 'exhausted' after 3 no-progress restarts", async () => {
    process.env["NLM_ALERT_WEBHOOK"] = WEBHOOK;
    try {
      const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchImpl = fakeFetch(posts);
      const children: FakeChild[] = [];
      const clock = new FakeClock();

      const supervisor = new JobSupervisor({
        spawnChild: fakeSpawner(children),
        clock,
        maxRestartsWithoutProgress: 3,
        onEvent: (event) => {
          void fireAlert(buildJobAlertEvent(event), { fetchImpl });
        },
      });

      supervisor.start(["--limit", "10"]);
      // 1 initial spawn + 3 no-progress restarts = 4 spawns, the 4th exit
      // trips exhaustion.
      for (let i = 0; i < 4; i++) {
        children[i]!.emitExit(1);
      }

      await new Promise((r) => setTimeout(r, 0));

      expect(posts).toHaveLength(1);
      expect(posts[0]!.body["type"]).toBe("nlm.job.stalled");
      const data = posts[0]!.body["data"] as Record<string, unknown>;
      expect(data["reason"]).toBe("exhausted");
      expect(data["restarts"]).toBe(4);
      expect(String(data["message"])).toMatch(/gave up after 4 fruitless restarts/);
    } finally {
      delete process.env["NLM_ALERT_WEBHOOK"];
    }
  });
});
