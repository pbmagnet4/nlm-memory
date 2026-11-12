/**
 * Event-loop lag monitor + per-job wall-time wrapper (T679).
 *
 * Why: prompt-recall hooks time out on most prompts (47-75 timeouts/day vs
 * 14-39 ok, 2026-11-09..11) while the very same GET /api/recall answers in
 * 0.3-0.6s when the daemon is idle. That signature is not a slow query, it is
 * the main thread being busy: better-sqlite3 is synchronous, so one unbounded
 * statement in a background job freezes every in-flight HTTP request for its
 * whole duration. Nothing in the daemon measured which job, or for how long, so
 * this module closes that gap:
 *
 *   • `startLoopLagMonitor` — process-wide sampler that logs
 *     `[loop] lag p99=..` every 5 minutes (plus the longest single block in the
 *     window). Answers "is the loop frozen even when no job is running".
 *   • `timeJob` — wraps one named job and logs `[loop] <job> took <ms>ms` when
 *     a *single synchronous slice* inside it crossed the threshold. Wall time
 *     alone is not the signal: an ingest tick legitimately awaits a 90s
 *     classify call and blocks nothing in the meantime. The synchronous slice
 *     decides whether we log; the wall time is reported next to it.
 *
 * The fix side of T679 uses `yieldToEventLoop` (`@core/util/yield-loop.js`) to
 * hand the loop a turn between batches of the work described here.
 *
 * Measurement, and why it is not just `monitorEventLoopDelay`:
 * `monitorEventLoopDelay`'s histogram is used for the percentiles, but its own
 * `max` was measured (node 22.22.3 / macOS, 2026-11-11) to report 15.2ms for a
 * single 160ms synchronous spin. `syncSliceProbe` measures the overrun of its
 * own timer schedule instead and reports 161.6ms for the same block, so it is
 * the authority for "how long was the loop blocked" everywhere a single block
 * is what matters.
 *
 * Attribution caveat: sampling is process-wide. When two jobs overlap, a block
 * from either is reported against whichever job the probe was watching — the
 * same offender appearing under several job names means the block is elsewhere.
 *
 * T1757 closes most of that caveat. `defaultActiveJobSet` records which jobs are
 * running *right now*, so when the sampler sees a block over
 * `DEFAULT_STALL_MS` the monitor can name the jobs that were on the loop at that
 * instant — `[loop] stall <ms>ms during: <jobs>` — rather than waiting five min
 * for the window report and blaming the job that happens to be running then. A
 * job that is named but whose work is genuinely async is then ruled out by
 * `timeSyncSlice`, which brackets one synchronous segment and logs
 * `[loop] sync <job>:<label> <ms>ms` past 250ms: that is the statement to fix.
 *
 * Logging goes through the caller's logger so tests capture lines instead of
 * writing to the operator's stderr.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** A single synchronous slice this long is worth a log line. Below it a hook
 *  with a 4s budget still gets its answer; above it prompt-recall starts
 *  racing the deadline. */
export const DEFAULT_SYNC_SLICE_THRESHOLD_MS = 250;
/** How often the lag summary is emitted (5 minutes, per T679). */
export const DEFAULT_LAG_REPORT_INTERVAL_MS = 5 * 60_000;
/** Sampling period for both the overrun sampler and the lag histogram. Must
 *  stay well under the logging threshold or short-but-frequent blocks go
 *  unmeasured. */
export const DEFAULT_PROBE_RESOLUTION_MS = 20;

const NS_PER_MS = 1e6;

/** Block length at which the lag monitor names the jobs it caught the loop in.
 *  Half the logging threshold: a 500ms freeze already eats an eighth of a hook's
 *  4s budget, and the whole point is to catch them before they pile up. */
export const DEFAULT_STALL_MS = 500;

/** Label used when a stall happened while no tracked job was on the loop — i.e.
 *  the block came from request handling or a timer nobody registered. */
export const UNTRACKED_JOBS_LABEL = "no tracked job";

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Reads the longest single synchronous block observed so far. */
export interface SyncSliceProbe {
  /** Longest synchronous slice in ms without changing what was measured. */
  read(): number;
  /** Longest synchronous slice in ms, then release the sampler. Idempotent: a
   *  second call returns 0 rather than double-reporting the same block. */
  stop(): number;
}

/** Creates a probe. Injected in tests so the threshold logic is verifiable
 *  without blocking a real event loop. */
export type SyncSliceProbeFactory = () => SyncSliceProbe;

/** Windowed max-overrun sampler: arms a `setInterval` and remembers how far
 *  behind its own schedule it fell. See syncSliceProbe for the rationale.
 *
 *  `onBlock` (T1757) fires from the timer callback — i.e. immediately after the
 *  block ends and before any further work — which is why the caller can read the
 *  active-job set there and get the jobs that were actually on the loop rather
 *  than whatever is running five minutes later. */
function createOverrunSampler(
  resolutionMs: number,
  opts: { readonly blockThresholdMs?: number; readonly onBlock?: (blockMs: number) => void } = {},
) {
  let prev = performance.now();
  let maxOverrun = 0;
  let stopped = false;
  const timer = setInterval(() => {
    // setInterval coalesces missed firings into one late call, so a long block
    // shows up here as one big overrun rather than a run of small ones.
    const now = performance.now();
    const overrun = now - prev - resolutionMs;
    if (overrun > maxOverrun) maxOverrun = overrun;
    prev = now;
    const threshold = opts.blockThresholdMs;
    if (opts.onBlock && threshold !== undefined && overrun > threshold) opts.onBlock(overrun);
  }, resolutionMs);
  timer.unref?.();
  return {
    read(): number {
      return stopped ? 0 : Math.max(0, maxOverrun);
    },
    reset(): void {
      maxOverrun = 0;
      prev = performance.now();
    },
    stop(): number {
      if (stopped) return 0;
      const value = Math.max(0, maxOverrun);
      stopped = true;
      clearInterval(timer);
      return value;
    },
  };
}

/** Probe backed by the overrun sampler.
 *
 *  Why not `monitorEventLoopDelay` for this, given that is the obvious tool?
 *  Measured on the shipping runtime (node 22.22.3, macOS, 2026-11-11): one 160ms
 *  synchronous spin makes that histogram report max = 15.2ms, while this sampler
 *  reports 161.6ms. Its `max` is unusable as a per-block measurement on this
 *  platform, so the sampler is the authority for single blocks and the
 *  histogram stays in the lag monitor for percentiles, where coarse sampling is
 *  good enough. The estimate reads about one `resolutionMs` low (the overrun is
 *  measured against a nominal tick) — noise against a 250ms threshold. */
export function syncSliceProbe(resolutionMs: number = DEFAULT_PROBE_RESOLUTION_MS): SyncSliceProbeFactory {
  return () => {
    const sampler = createOverrunSampler(resolutionMs);
    return { read: sampler.read, stop: sampler.stop };
  };
}

/** Probe that always reports a fixed slice — for exercising the threshold. */
export function fixedSliceProbe(ms: number): SyncSliceProbeFactory {
  return () => {
    let stopped = false;
    return {
      read(): number {
        return stopped ? 0 : ms;
      },
      stop(): number {
        if (stopped) return 0;
        stopped = true;
        return ms;
      },
    };
  };
}

/**
 * Which jobs are on the loop right now. `timeJob` wrappers enter a name for the
 * whole lifetime of the job (head *and* its awaits), so `active()` is the set of
 * plausible authors of a stall observed at this instant. Overlapping runs of the
 * same job collapse to one entry with a count.
 */
export interface ActiveJobSet {
  /** Enter `name`. Call the returned function exactly once when it finishes. */
  enter(name: string): () => void;
  /** Active names in first-entered order, e.g. `["scheduler-tick", "alert-health x2"]`. */
  active(): readonly string[];
  /** Number of active entries (names × counts) — for tests. */
  get size(): number;
}

export function createActiveJobSet(): ActiveJobSet {
  // Map preserves insertion order, so `active()` reads oldest-first: the job
  // that has been running longest is the more likely author of a long block.
  const counts = new Map<string, number>();
  return {
    enter(name: string): () => void {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      let released = false;
      return () => {
        // A double-release (finally in both a wrapper and its callee) must not
        // drop another run's count.
        if (released) return;
        released = true;
        const left = (counts.get(name) ?? 0) - 1;
        if (left > 0) counts.set(name, left);
        else counts.delete(name);
      };
    },
    active(): readonly string[] {
      return [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
    },
    get size(): number {
      let total = 0;
      for (const n of counts.values()) total += n;
      return total;
    },
  };
}

/** Process-wide set the lag monitor attributes stalls against. The daemon's job
 *  wrappers are the only writers; nothing resets it. */
export const defaultActiveJobSet: ActiveJobSet = createActiveJobSet();

/**
 * Run `run` while `name` is recorded as active, so any stall inside it is
 * attributed to it. Pass-through: result and errors are untouched, and the name
 * is released even when `run` throws or rejects. Fire-and-forget jobs still
 * release — the name drops when their promise settles.
 */
export async function withActiveJob<T>(
  name: string,
  run: () => Promise<T> | T,
  set: ActiveJobSet = defaultActiveJobSet,
): Promise<T> {
  const leave = set.enter(name);
  try {
    return await run();
  } finally {
    leave();
  }
}

/** The active-job set is only useful if the name reaches the code that blocks,
 *  so modules take this instead of a job string. */
export type JobLabel = string;

/** One stall attribution. The line names the worst block per window. */
export interface StallAttributor {
  /** Feed one observed synchronous block. True when it produced a log line. */
  observe(blockMs: number): boolean;
  /** Longest block attributed since the last `reset` (0 when none). */
  readonly attributedMs: number;
  /** Start a new window (keeps the threshold and logger). */
  reset(): void;
}

export interface StallAttributorOptions {
  readonly logger: (msg: string) => void;
  /** Blocks under this length are not attributed. */
  readonly thresholdMs?: number;
  /** Jobs to name. Defaults to the process-wide set. */
  readonly activeJobs?: () => readonly string[];
}

/**
 * Turns "the loop froze for N ms" into "the loop froze for N ms during X".
 *
 * One line per window, for the worst block only: a job that blocks in a loop
 * would otherwise emit a line per iteration, and the first stall of a burst is
 * the one that matters. `reset()` (called on every lag report) re-arms it, so a
 * window with two separate offenders still gets both named.
 */
export function createStallAttributor(opts: StallAttributorOptions): StallAttributor {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALL_MS;
  const getJobs = opts.activeJobs ?? (() => defaultActiveJobSet.active());
  let attributedMs = 0;
  return {
    observe(blockMs: number): boolean {
      if (blockMs < thresholdMs || blockMs <= attributedMs) return false;
      attributedMs = blockMs;
      const jobs = getJobs();
      opts.logger(
        `[loop] stall ${roundMs(blockMs)}ms during: ${jobs.length > 0 ? jobs.join(", ") : UNTRACKED_JOBS_LABEL}`,
      );
      return true;
    },
    get attributedMs(): number {
      return attributedMs;
    },
    reset(): void {
      attributedMs = 0;
    },
  };
}

/** Options for the synchronous-segment timers (T1757). */
export interface SyncSliceTimingOptions {
  /** Segment length that triggers a log line. Default 250ms, same as `timeJob`. */
  readonly thresholdMs?: number;
  /** Defaults to console.error. */
  readonly logger?: (msg: string) => void;
  /** Monotonic clock. Defaults to `performance.now` (fractional ms, immune to
   *  wall-clock jumps — these are short measurements). */
  readonly now?: () => number;
}

/** Brackets named synchronous segments inside one job. See `timeSyncSlice`. */
export interface SyncStopwatch {
  time<T>(label: string, fn: () => T): T;
}

/**
 * Run one *synchronous* segment and log `[loop] sync <job>:<label> <ms>ms` when
 * it reached `thresholdMs`. Returns exactly what `fn` returns and lets its
 * errors through — this observes only.
 *
 * Where `timeJob` says "a job took a long time" and the lag monitor says "the
 * loop froze", this names the statement: pass a whole `.all()` / `.run()` /
 * `.iterate()` loop or a `JSON.parse` of a large blob — nothing that awaits. An
 * awaited segment would measure wall time, which is not the signal.
 */
export function timeSyncSlice<T>(job: string, label: string, fn: () => T, opts: SyncSliceTimingOptions = {}): T {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_SYNC_SLICE_THRESHOLD_MS;
  const now = opts.now ?? ((): number => performance.now());
  const startedAt = now();
  try {
    return fn();
  } finally {
    const ms = Math.max(0, now() - startedAt);
    if (ms >= thresholdMs) {
      const logger = opts.logger ?? ((msg: string) => console.error(msg));
      logger(`[loop] sync ${job}:${label} ${roundMs(ms)}ms`);
    }
  }
}

/** `timeSyncSlice` with the job name and options bound once at the job boundary. */
export function createSyncStopwatch(job: string, opts: SyncSliceTimingOptions = {}): SyncStopwatch {
  return { time: <T>(label: string, fn: () => T): T => timeSyncSlice(job, label, fn, opts) };
}

/** One completed job measurement. Exposed for tests and future metrics sinks. */
export interface JobSample {
  readonly job: string;
  readonly wallMs: number;
  readonly syncSliceMs: number;
  /** Whether the slice crossed `thresholdMs`, i.e. whether a line was logged. */
  readonly logged: boolean;
}

export interface JobTimingOptions {
  /** Synchronous-slice length that triggers a log line. Default 250ms. */
  readonly thresholdMs?: number;
  /** Defaults to console.error. */
  readonly logger?: (msg: string) => void;
  /** Defaults to a live `syncSliceProbe`. */
  readonly probe?: SyncSliceProbeFactory;
  readonly now?: () => number;
  /** Called for every job, logged or not. Lets a test assert the silent path. */
  readonly onSample?: (sample: JobSample) => void;
}

/** Whether `value` was awaited rather than computed inline. */
function isThenable<T>(value: Promise<T> | T): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

/**
 * Run `run` and log `[loop] <job> took <wall>ms (sync slice <slice>ms)` when a
 * single synchronous slice inside it reached `thresholdMs`. The job's result and
 * its errors pass through untouched — this observes, it never interferes.
 *
 * The slice is the larger of two measurements:
 *   • the *head* — exactly how long `run()` took to hand back control, read from
 *     the clock the instant it returns a promise. For a fully synchronous job
 *     this is the whole block, measured precisely; no sampler can see a block
 *     that never yielded, which is why the clock rather than the probe measures
 *     it.
 *   • the *tail* — the longest overrun the probe saw while the job was awaiting,
 *     i.e. blocking done by continuation ticks after the head.
 */
export async function timeJob<T>(
  job: string,
  run: () => Promise<T> | T,
  opts: JobTimingOptions = {},
): Promise<T> {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_SYNC_SLICE_THRESHOLD_MS;
  const logger = opts.logger ?? ((msg: string) => console.error(msg));
  const now = opts.now ?? Date.now;
  const probe = (opts.probe ?? syncSliceProbe())();
  const startedAt = now();
  let pending: Promise<T> | T;
  let earlyError: unknown;
  let threwEarly = false;
  try {
    pending = run();
  } catch (e) {
    threwEarly = true;
    earlyError = e;
    pending = null as unknown as Promise<T>;
  }
  const headMs = Math.max(0, now() - startedAt);
  try {
    if (threwEarly) throw earlyError;
    return isThenable(pending) ? await pending : pending;
  } finally {
    const syncSliceMs = Math.max(headMs, probe.stop());
    const wallMs = Math.max(0, now() - startedAt);
    const logged = syncSliceMs >= thresholdMs;
    opts.onSample?.({ job, wallMs, syncSliceMs, logged });
    if (logged) {
      logger(
        `[loop] ${job} took ${roundMs(wallMs)}ms (sync slice ${roundMs(syncSliceMs)}ms; hook budget 4000ms)`,
      );
    }
  }
}

export interface LoopLagSnapshot {
  readonly p50Ms: number;
  readonly p99Ms: number;
  /** Longest single synchronous block in the window, from the overrun sampler
   *  (see syncSliceProbe for why this is not the histogram's own max). */
  readonly maxMs: number;
  /** Wall time covered by this window. */
  readonly windowMs: number;
}

export interface LoopLagMonitor {
  /** Emit the `[loop] lag p99=..` line for the window so far and reset it.
   *  Returns the numbers it reported (null when nothing was sampled yet). */
  report(): LoopLagSnapshot | null;
  /** Current window numbers without logging or resetting. */
  snapshot(): LoopLagSnapshot | null;
  /** Stop the samplers and the reporting timer. Idempotent. */
  stop(): void;
}

export interface LoopLagMonitorOptions {
  /** Defaults to console.error. */
  readonly logger?: (msg: string) => void;
  readonly reportIntervalMs?: number;
  readonly resolutionMs?: number;
  readonly now?: () => number;
  /** Set false in tests that only call report()/snapshot() directly. */
  readonly autoStart?: boolean;
  /** Block length at which to name the running jobs. Default 500ms. */
  readonly stallThresholdMs?: number;
  /** Set false to keep the lag numbers without stall attribution. */
  readonly stallAttribution?: boolean;
  /** Author lookup for `[loop] stall`. Defaults to `defaultActiveJobSet`. */
  readonly activeJobs?: () => readonly string[];
  /** T1771: called for *every* observed block over `stallObserveMs`, independent
   *  of the attribution line — the metrics sink behind /api/health/slo. Fires
   *  from the sampler callback, so it must not throw or block. */
  readonly onStallObserved?: (blockMs: number) => void;
  /** Threshold for `onStallObserved`; default `stallThresholdMs`, i.e. the
   *  observer sees exactly the blocks the `[loop] stall` line reports. The
   *  daemon passes the SLO's 250ms to count smaller blocks too. */
  readonly stallObserveMs?: number;
}

/**
 * Process-wide event-loop lag monitor. Logs
 * `[loop] lag p99=<ms>ms (p50=.. max=.. window=..)` every `reportIntervalMs`
 * (default 5 minutes) and resets the window, so a burst of blocking work shows
 * up as one spike instead of being diluted by the quiet hours around it.
 *
 * Separately, and immediately rather than at the report, it logs
 * `[loop] stall <ms>ms during: <jobs>` when a single block crosses
 * `stallThresholdMs` — see `createStallAttributor`.
 */
export function startLoopLagMonitor(opts: LoopLagMonitorOptions = {}): LoopLagMonitor {
  const logger = opts.logger ?? ((msg: string) => console.error(msg));
  const reportIntervalMs = opts.reportIntervalMs ?? DEFAULT_LAG_REPORT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const resolutionMs = opts.resolutionMs ?? DEFAULT_PROBE_RESOLUTION_MS;
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  const attributor =
    opts.stallAttribution === false
      ? null
      : createStallAttributor({
          logger,
          thresholdMs: opts.stallThresholdMs ?? DEFAULT_STALL_MS,
          ...(opts.activeJobs ? { activeJobs: opts.activeJobs } : {}),
        });
  const maxSampler = createOverrunSampler(resolutionMs, (() => {
    const stallThreshold = opts.stallThresholdMs ?? DEFAULT_STALL_MS;
    const observeMs = opts.stallObserveMs ?? stallThreshold;
    const onStallObserved = opts.onStallObserved;
    if (!attributor && !onStallObserved) return {};
    // Fire the callback at the lowest threshold anyone listens at; each
    // consumer applies its own gate (the attributor re-checks 500ms).
    const fireMs = Math.min(
      attributor ? stallThreshold : Number.POSITIVE_INFINITY,
      onStallObserved ? observeMs : Number.POSITIVE_INFINITY,
    );
    return {
      blockThresholdMs: fireMs,
      onBlock: (blockMs: number) => {
        attributor?.observe(blockMs);
        if (onStallObserved && blockMs >= observeMs) onStallObserved(blockMs);
      },
    };
  })());
  let windowStart = now();
  let timer: NodeJS.Timeout | null = null;

  const read = (): LoopLagSnapshot | null => {
    if (histogram.count === 0) {
      // The sampler has recorded nothing since the last reset — normally a
      // window shorter than the resolution, in which case there is genuinely
      // nothing to say.
      return null;
    }
    return {
      p50Ms: roundMs(histogram.percentile(50) / NS_PER_MS),
      p99Ms: roundMs(histogram.percentile(99) / NS_PER_MS),
      maxMs: roundMs(maxSampler.read()),
      windowMs: Math.max(0, now() - windowStart),
    };
  };

  const monitor: LoopLagMonitor = {
    report(): LoopLagSnapshot | null {
      const snap = read();
      histogram.reset();
      maxSampler.reset();
      // Re-arm attribution with the new window, so the worst block of each
      // window gets its own line instead of only the first one ever seen.
      attributor?.reset();
      windowStart = now();
      if (!snap) return null;
      logger(
        `[loop] lag p99=${snap.p99Ms}ms (p50=${snap.p50Ms}ms max=${snap.maxMs}ms window=${Math.round(snap.windowMs / 1000)}s)`,
      );
      return snap;
    },
    snapshot(): LoopLagSnapshot | null {
      return read();
    },
    stop(): void {
      histogram.disable();
      histogram.reset();
      maxSampler.stop();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  if (opts.autoStart !== false) {
    // unref: a diagnostic sampler must never be the reason the daemon stays up.
    timer = setInterval(() => {
      monitor.report();
    }, reportIntervalMs);
    timer.unref?.();
  }
  return monitor;
}
