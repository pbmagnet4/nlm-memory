import { describe, expect, it } from "vitest";
import { JobSupervisor } from "../../../../src/core/jobs/job-supervisor.js";
import type { ChildHandle, SpawnChild } from "../../../../src/ports/spawn-child.js";

class Child implements ChildHandle {
  line: ((l: string) => void) | null = null;
  exit: ((c: number | null) => void) | null = null;
  onLine(cb: (l: string) => void): void { this.line = cb; }
  onExit(cb: (c: number | null) => void): void { this.exit = cb; }
  kill(): void {}
}

function make(job: string) {
  const spawned: Array<{ args: string[]; env: Record<string, string> | undefined; child: Child }> = [];
  const spawnChild: SpawnChild = (args, env) => {
    const child = new Child();
    spawned.push({ args, env, child });
    return child;
  };
  const events: Array<{ job: string }> = [];
  const sup = new JobSupervisor({
    job,
    spawnChild,
    clock: { now: () => 0, setInterval: () => {} },
    onEvent: (e) => events.push(e),
    maxRestartsWithoutProgress: 1,
    log: () => {},
  });
  return { sup, spawned, events };
}

describe("JobSupervisor job label and child env", () => {
  it("labels the snapshot, the already-active error and events with the configured job name", () => {
    const { sup, spawned, events } = make("embed-rebuild");
    sup.start([]);
    expect(sup.snapshot().name).toBe("embed-rebuild");
    expect(() => sup.start([])).toThrow("embed-rebuild job already active");
    spawned[0]!.child.exit!(1);
    spawned[1]!.child.exit!(1);
    expect(events).toEqual([expect.objectContaining({ kind: "exhausted", job: "embed-rebuild" })]);
  });

  it("passes the start env to the child, again on a respawn, and keeps it out of the snapshot", () => {
    const { sup, spawned } = make("embed-rebuild");
    sup.start(["--x"], { NLM_EMBED_API_KEY: "secret" });
    expect(spawned[0]).toMatchObject({ args: ["--x"], env: { NLM_EMBED_API_KEY: "secret" } });
    spawned[0]!.child.exit!(1);
    expect(spawned[1]!.env).toEqual({ NLM_EMBED_API_KEY: "secret" });
    expect(JSON.stringify(sup.snapshot())).not.toContain("secret");
  });
});
