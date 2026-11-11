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
 * That still answers the question we have (which window, how often) at a
 * fraction of the cost of instrumenting every statement.
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
 *  behind its own schedule it fell. See syncSliceProbe for the rationale. */
function createOverrunSampler(resolutionMs: number) {
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
}

/**
 * Process-wide event-loop lag monitor. Logs
 * `[loop] lag p99=<ms>ms (p50=.. max=.. window=..)` every `reportIntervalMs`
 * (default 5 minutes) and resets the window, so a burst of blocking work shows
 * up as one spike instead of being diluted by the quiet hours around it.
 */
export function startLoopLagMonitor(opts: LoopLagMonitorOptions = {}): LoopLagMonitor {
  const logger = opts.logger ?? ((msg: string) => console.error(msg));
  const reportIntervalMs = opts.reportIntervalMs ?? DEFAULT_LAG_REPORT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const resolutionMs = opts.resolutionMs ?? DEFAULT_PROBE_RESOLUTION_MS;
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  const maxSampler = createOverrunSampler(resolutionMs);
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
