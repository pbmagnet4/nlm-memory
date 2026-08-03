/**
 * JobSupervisor — owns at most one child `reprocess` run at a time.
 *
 * Built because a detached `nlm reprocess` died on a V8 OOM and sat dead
 * ~16h unobserved (twice: 07-27 and 07-27→08-03). Supervision now lives in
 * the daemon instead of a bolt-on watchdog script: this class tracks a
 * single child process's progress, restarts it on a non-clean exit while
 * work remains, and reports stalls when the child is alive but stuck.
 *
 * One job type only (reprocess) — no generic job framework (YAGNI). Ports
 * (`spawnChild`, `clock`) are injected so this stays pure-core: no real
 * child_process, no real timers, testable with fakes. Same posture as
 * `ScanScheduler` (src/core/scheduler/scheduler.ts).
 *
 * Progress-line format verified directly in src/cli/nlm.ts's `reprocess`
 * command (the only place reprocess's `onProgress` callback is wired to
 * output — reprocess.ts itself never prints, it just calls the callback):
 *
 *   process.stderr.write(`  [${i}/${n}] ${sid}  ${status}\n`);
 *
 * i.e. two leading spaces, `[i/n]` (no zero-padding), a single space, the
 * session id, TWO spaces, then a status word (`ok`, `empty_body`,
 * `classify_failed`, or `ingest_failed`). The plan's assumed format
 * (`[N/total] <id> ok`) was close but understated the leading indent and
 * the double space before status. `processed` in reprocess.ts increments
 * on every branch (success or failure), so ANY line matching `[i/n]` is a
 * genuine advance regardless of the trailing status word — the parser
 * below only needs the two numbers.
 *
 * Restart policy: child exit with work remaining → re-spawn same args, up
 * to `maxRestartsWithoutProgress` (default 3) consecutive restarts with no
 * progress observed since the last one. A progress line resets the
 * counter to 0. Exceeding the cap fires `{kind: "exhausted"}` and stops
 * respawning. "Work remaining" is `code !== 0` (covers OOM/signal kills
 * and any non-clean exit, including one where no progress line was ever
 * seen) OR `processed < total` on an otherwise-clean exit — reprocess only
 * exits 0 after its `work` loop finishes every item, so a clean exit with
 * `processed < total` is a defensive fallback, not the expected path.
 *
 * Stall: child alive, no progress advance for `stallMinutes` (default 20,
 * from `NLM_JOB_STALL_MINUTES`) → fires `{kind: "stalled"}` ONCE per stall
 * episode. A later progress advance ends the episode (state returns to
 * "running"); a subsequent stall re-arms and can fire again. Checked on a
 * coarse interval behind the injected `clock` port so tests never need
 * real timers.
 *
 * `restarts` in both the snapshot and event payloads is the
 * restarts-without-progress counter (reset by any advance), not a
 * lifetime total — it directly explains "why is this run stalled/
 * exhausted" the way an operator reading /api/health would want.
 *
 * State machine: "idle" (never started, or this JobSupervisor instance's
 * initial state — not one of the plan's five snapshot states, but the
 * natural "no job block" representation Task 2's health-route mapping
 * needs) → "running" → ("stalled" ⇄ "running" across stall episodes) →
 * terminal "completed" | "exhausted" | "stopped". A terminal state is
 * left only by calling `start()` again, which begins a fresh run.
 *
 * Stale-callback safety: `spawnAndWire` captures the child instance it just
 * spawned and every onLine/onExit callback checks `this.child === child`
 * before touching any state. A killed child (stop(), or a fast respawn
 * chain) can still deliver a queued exit or line after this.child has moved
 * on to a newer child or gone null; without the identity guard that stale
 * delivery would corrupt the live run's processed/total/restarts, null out
 * the live child (leaking it — now unmanaged and unkillable), or trigger a
 * bogus respawn.
 */

import type { ChildHandle, SpawnChild } from "@ports/spawn-child.js";
import type { Clock } from "@ports/clock.js";

export type JobState =
  | "idle"
  | "running"
  | "stalled"
  | "completed"
  | "exhausted"
  | "stopped";

export interface JobSnapshot {
  readonly name: "reprocess";
  readonly state: JobState;
  readonly processed: number;
  readonly total: number;
  readonly startedAt: string | null;
  readonly lastAdvanceAt: string | null;
  readonly restarts: number;
}

interface JobSupervisorEventBase {
  readonly job: "reprocess";
  readonly processed: number;
  readonly total: number;
  readonly restarts: number;
  readonly lastAdvanceAt: string | null;
}

export type JobSupervisorEvent =
  | ({ readonly kind: "stalled" } & JobSupervisorEventBase)
  | ({ readonly kind: "exhausted" } & JobSupervisorEventBase);

export interface JobSupervisorOptions {
  readonly spawnChild: SpawnChild;
  readonly clock: Clock;
  /** Alert-firing port. Never let a throwing consumer crash the supervisor. */
  readonly onEvent?: (event: JobSupervisorEvent) => void;
  /** Default: NLM_JOB_STALL_MINUTES env var, else 20. */
  readonly stallMinutes?: number;
  readonly maxRestartsWithoutProgress?: number;
  /** How often the stall condition is (re-)evaluated. Default 60s. */
  readonly stallCheckIntervalMs?: number;
  /** Defaults to console.error. Set to a noop in tests. */
  readonly log?: (msg: string) => void;
}

const DEFAULT_STALL_MINUTES = 20;
const DEFAULT_MAX_RESTARTS_WITHOUT_PROGRESS = 3;
const DEFAULT_STALL_CHECK_INTERVAL_MS = 60_000;

// Matches the two-space-indented `[i/n] <sid>  <status>` verbose line reprocess's
// CLI wiring writes (src/cli/nlm.ts, reprocess command). Only the counters
// matter: reprocess increments `processed` on every outcome branch, so any
// line of this shape is an advance regardless of what follows it.
const PROGRESS_RE = /^\s*\[(\d+)\/(\d+)\]/;

function stallMinutesFromEnv(): number {
  const raw = process.env["NLM_JOB_STALL_MINUTES"];
  if (raw === undefined) return DEFAULT_STALL_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALL_MINUTES;
}

export class JobSupervisor {
  private readonly spawnChildFn: SpawnChild;
  private readonly clock: Clock;
  private readonly onEventCb: (event: JobSupervisorEvent) => void;
  private readonly stallMs: number;
  private readonly maxRestartsWithoutProgress: number;
  private readonly log: (msg: string) => void;

  private state: JobState = "idle";
  private args: string[] = [];
  private child: ChildHandle | null = null;
  private processed = 0;
  private total = 0;
  private startedAt: string | null = null;
  private lastAdvanceAt: string | null = null;
  private restarts = 0;
  private stallEpisodeFired = false;
  private stopRequested = false;

  constructor(opts: JobSupervisorOptions) {
    this.spawnChildFn = opts.spawnChild;
    this.clock = opts.clock;
    this.onEventCb = opts.onEvent ?? (() => {});
    this.stallMs = (opts.stallMinutes ?? stallMinutesFromEnv()) * 60_000;
    this.maxRestartsWithoutProgress =
      opts.maxRestartsWithoutProgress ?? DEFAULT_MAX_RESTARTS_WITHOUT_PROGRESS;
    this.log = opts.log ?? ((msg) => console.error(msg));
    const stallCheckIntervalMs = opts.stallCheckIntervalMs ?? DEFAULT_STALL_CHECK_INTERVAL_MS;
    this.clock.setInterval(() => this.checkStall(), stallCheckIntervalMs);
  }

  /** Starts a new run. Refuses (throws) if a run is already active. */
  start(args: string[]): void {
    if (this.state === "running" || this.state === "stalled") {
      throw new Error("reprocess job already active");
    }
    this.args = args;
    this.processed = 0;
    this.total = 0;
    this.restarts = 0;
    this.stallEpisodeFired = false;
    this.stopRequested = false;
    this.startedAt = new Date(this.clock.now()).toISOString();
    this.lastAdvanceAt = null;
    this.state = "running";
    this.spawnAndWire();
  }

  /** Kills the active child (if any) and moves to "stopped". No-op if idle/terminal. */
  stop(): void {
    if (this.state !== "running" && this.state !== "stalled") return;
    this.stopRequested = true;
    const child = this.child;
    this.child = null;
    this.state = "stopped";
    try {
      child?.kill();
    } catch (e) {
      this.log(`[job-supervisor] kill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  snapshot(): JobSnapshot {
    return {
      name: "reprocess",
      state: this.state,
      processed: this.processed,
      total: this.total,
      startedAt: this.startedAt,
      lastAdvanceAt: this.lastAdvanceAt,
      restarts: this.restarts,
    };
  }

  private spawnAndWire(): void {
    const child = this.spawnChildFn(this.args);
    this.child = child;
    // Identity-guard every callback against `this.child`: a killed-but-not-yet-
    // exited child (stop(), or a respawn racing a slow exit/line delivery) can
    // still deliver onLine/onExit after this.child has moved on to a newer
    // child (or null). Without this guard a stale callback from child A would
    // mutate state for the live run, null out this.child (leaking A's
    // now-unmanaged, unkillable successor if A had one), or trigger a bogus
    // restart/respawn.
    child.onLine((line) => {
      if (this.child !== child) return;
      try {
        this.handleLine(line);
      } catch (e) {
        this.log(`[job-supervisor] onLine handler error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    child.onExit((code) => {
      if (this.child !== child) return;
      try {
        this.handleExit(code);
      } catch (e) {
        this.log(`[job-supervisor] onExit handler error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  private handleLine(line: string): void {
    const match = PROGRESS_RE.exec(line);
    if (!match) return;
    const processed = Number(match[1]!);
    const total = Number(match[2]!);
    if (!Number.isFinite(processed) || !Number.isFinite(total)) return;
    this.processed = processed;
    this.total = total;
    this.lastAdvanceAt = new Date(this.clock.now()).toISOString();
    this.restarts = 0;
    if (this.state === "stalled") this.state = "running";
    this.stallEpisodeFired = false;
  }

  private handleExit(code: number | null): void {
    this.child = null;
    if (this.stopRequested) return; // stop() already set state to "stopped"

    const workRemaining = code !== 0 || (this.total > 0 && this.processed < this.total);
    if (!workRemaining) {
      this.state = "completed";
      return;
    }

    this.restarts += 1;
    if (this.restarts > this.maxRestartsWithoutProgress) {
      this.state = "exhausted";
      this.emitEvent({
        kind: "exhausted",
        job: "reprocess",
        processed: this.processed,
        total: this.total,
        restarts: this.restarts,
        lastAdvanceAt: this.lastAdvanceAt,
      });
      return;
    }

    this.state = "running";
    this.stallEpisodeFired = false;
    this.spawnAndWire();
  }

  private checkStall(): void {
    try {
      if (this.state !== "running" && this.state !== "stalled") return;
      if (!this.child) return;
      if (this.stallEpisodeFired) return;
      const referenceIso = this.lastAdvanceAt ?? this.startedAt;
      if (!referenceIso) return;
      const elapsed = this.clock.now() - Date.parse(referenceIso);
      if (elapsed < this.stallMs) return;
      this.stallEpisodeFired = true;
      this.state = "stalled";
      this.emitEvent({
        kind: "stalled",
        job: "reprocess",
        processed: this.processed,
        total: this.total,
        restarts: this.restarts,
        lastAdvanceAt: this.lastAdvanceAt,
      });
    } catch (e) {
      this.log(`[job-supervisor] stall check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private emitEvent(event: JobSupervisorEvent): void {
    try {
      this.onEventCb(event);
    } catch (e) {
      this.log(`[job-supervisor] onEvent handler threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
