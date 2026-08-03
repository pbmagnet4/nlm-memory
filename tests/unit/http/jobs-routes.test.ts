// tests/unit/http/jobs-routes.test.ts
//
// POST/DELETE /api/jobs/reprocess — thin HTTP wrapping over JobSupervisor
// (core/jobs/job-supervisor.ts). start() throws synchronously both when a
// run is already active and when the injected spawnChild adapter itself
// fails; the route must catch both and never let either crash the daemon
// (binding note from Task 1's review).
import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { JobSnapshot } from "../../../src/core/jobs/job-supervisor.js";

const IDLE_SNAPSHOT: JobSnapshot = {
  name: "reprocess",
  state: "idle",
  processed: 0,
  total: 0,
  startedAt: null,
  lastAdvanceAt: null,
  restarts: 0,
};

const RUNNING_SNAPSHOT: JobSnapshot = {
  name: "reprocess",
  state: "running",
  processed: 3,
  total: 10,
  startedAt: "2026-08-03T00:00:00.000Z",
  lastAdvanceAt: "2026-08-03T00:00:05.000Z",
  restarts: 0,
};

const STOPPED_SNAPSHOT: JobSnapshot = {
  ...RUNNING_SNAPSHOT,
  state: "stopped",
};

function fakeSupervisor(opts: {
  startImpl?: (args: string[]) => void;
  snapshot?: () => JobSnapshot;
  stopImpl?: () => void;
} = {}) {
  const startCalls: string[][] = [];
  const stopCalls: number[] = [];
  let snap = opts.snapshot ?? (() => IDLE_SNAPSHOT);
  return {
    startCalls,
    stopCalls,
    start(args: string[]): void {
      startCalls.push(args);
      opts.startImpl?.(args);
    },
    stop(): void {
      stopCalls.push(1);
      opts.stopImpl?.();
    },
    snapshot(): JobSnapshot {
      return snap();
    },
    setSnapshot(fn: () => JobSnapshot): void {
      snap = fn;
    },
  };
}

function appWith(jobSupervisor?: ReturnType<typeof fakeSupervisor>) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    ...(jobSupervisor ? { jobSupervisor } : {}),
  } as never);
}

describe("POST /api/jobs/reprocess", () => {
  it("returns 503 when no job supervisor is wired", async () => {
    const app = appWith();
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: "{}",
    });
    expect(res.status).toBe(503);
  });

  it("202s and echoes the started snapshot", async () => {
    const supervisor = fakeSupervisor({ snapshot: () => RUNNING_SNAPSHOT });
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ args: ["--limit", "10"] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { snapshot: JobSnapshot };
    expect(body.snapshot.state).toBe("running");
    expect(supervisor.startCalls).toEqual([["--limit", "10"]]);
  });

  it("passes verbatim string args through to supervisor.start (no shell interpolation)", async () => {
    const supervisor = fakeSupervisor({ snapshot: () => RUNNING_SNAPSHOT });
    const app = appWith(supervisor);
    await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ args: ["--state", "/tmp/x; rm -rf /"] }),
    });
    expect(supervisor.startCalls).toEqual([["--state", "/tmp/x; rm -rf /"]]);
  });

  it("treats a missing body as no args", async () => {
    const supervisor = fakeSupervisor({ snapshot: () => RUNNING_SNAPSHOT });
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { host: "localhost:3940" },
    });
    expect(res.status).toBe(202);
    expect(supervisor.startCalls).toEqual([[]]);
  });

  it("rejects a non-array args field with 400", async () => {
    const supervisor = fakeSupervisor();
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ args: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    expect(supervisor.startCalls).toHaveLength(0);
  });

  it("409s when supervisor.start() throws because a run is already active", async () => {
    const supervisor = fakeSupervisor({
      startImpl: () => {
        throw new Error("reprocess job already active");
      },
      snapshot: () => RUNNING_SNAPSHOT,
    });
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  it("never crashes the daemon when supervisor.start() throws a spawn failure — returns a clean 500 instead", async () => {
    const supervisor = fakeSupervisor({
      startImpl: () => {
        throw new Error("ENOENT: spawn node");
      },
    });
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ENOENT");
  });
});

describe("DELETE /api/jobs/reprocess", () => {
  it("returns 503 when no job supervisor is wired", async () => {
    const app = appWith();
    const res = await app.request("/api/jobs/reprocess", {
      method: "DELETE",
      headers: { host: "localhost:3940" },
    });
    expect(res.status).toBe(503);
  });

  it("200s, calls stop(), and echoes the stopped snapshot", async () => {
    const supervisor = fakeSupervisor({ snapshot: () => STOPPED_SNAPSHOT });
    const app = appWith(supervisor);
    const res = await app.request("/api/jobs/reprocess", {
      method: "DELETE",
      headers: { host: "localhost:3940" },
    });
    expect(res.status).toBe(200);
    expect(supervisor.stopCalls).toHaveLength(1);
    const body = (await res.json()) as { snapshot: JobSnapshot };
    expect(body.snapshot.state).toBe("stopped");
  });
});
