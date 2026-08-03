/**
 * Real (non-core, side-effectful) adapters for JobSupervisor's reprocess
 * job — the daemon composition root (`nlm start`, src/cli/nlm.ts) wires
 * these; core/jobs/job-supervisor.ts only ever sees the ports (@ports/
 * clock.js, @ports/spawn-child.js). Thin and unremarkable by design (Task 1
 * report): no logic worth unit-testing beyond what job-supervisor.test.ts
 * already covers against fakes of these same shapes.
 */

import { spawn } from "node:child_process";
import type { ChildHandle, SpawnChild } from "../ports/spawn-child.js";
import type { Clock } from "../ports/clock.js";

/** Date.now() + a ref'd setInterval — JobSupervisor's stall-check interval
 *  is meant to live for the whole daemon process, so it is not unref'd. */
export const realClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    setInterval(fn, ms);
  },
};

export interface ReprocessSpawnOptions {
  /** process.execPath — the node binary running this daemon. */
  readonly execPath: string;
  /** This file's own on-disk path (dist/cli/nlm.js), i.e. `__filename`
   *  computed via fileURLToPath(import.meta.url) at the top of nlm.ts —
   *  the same self-spawn shape `nlm restart`'s pkill-respawn path and the
   *  LaunchAgent/systemd unit builders already use. */
  readonly nlmScriptPath: string;
}

/**
 * Spawns `node <nlm.js> reprocess -v <args>` and line-buffers stdout+stderr
 * into a single onLine stream (reprocess's -v progress lines go to stderr
 * per the `reprocess` command's own onProgress wiring in nlm.ts; combining
 * both means JobSupervisor never needs to care which fd a future output
 * change lands on).
 *
 * Args are always passed as separate argv entries to child_process.spawn,
 * never through a shell — a caller-supplied arg containing shell
 * metacharacters is just one literal argv element to the child, nothing it
 * can escape into.
 */
export function createReprocessSpawnChild(opts: ReprocessSpawnOptions): SpawnChild {
  return (args: string[]): ChildHandle => {
    const child = spawn(opts.execPath, [opts.nlmScriptPath, "reprocess", "-v", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lineCb: ((line: string) => void) | null = null;
    let exitCb: ((code: number | null) => void) | null = null;
    let buf = "";
    const feed = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lineCb?.(line);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);

    // A spawn-level error (e.g. ENOENT on a bad execPath/script path) may
    // fire "error" without a normal "exit" ever following — without
    // surfacing it as an exit, JobSupervisor would sit in "running" forever
    // instead of applying its restart/exhaust policy. Node's own docs say
    // "exit" can still follow "error" in some cases, so this can call
    // exitCb twice; that's harmless because job-supervisor.ts's
    // spawnAndWire nulls out `this.child` after the first exit and its
    // identity guard drops every callback after that.
    child.on("exit", (code) => {
      exitCb?.(code);
    });
    child.on("error", () => {
      exitCb?.(1);
    });

    return {
      onLine: (cb) => {
        lineCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: () => {
        child.kill();
      },
    };
  };
}
