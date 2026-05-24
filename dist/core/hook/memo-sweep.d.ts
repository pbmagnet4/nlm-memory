/**
 * Idle sweep for per-conversation hook memo files.
 *
 * The SessionEnd hook is best-effort — Claude Code doesn't fire it on
 * crashes, kill -9, or IDE force-close. Without a backstop, memo files
 * at ~/.nlm/hook-state/<conv>.json accumulate forever for any session
 * that didn't close cleanly.
 *
 * This sweep is the daemon-side backstop. It runs on a timer, scans the
 * state directory, and deletes any memo whose mtime is older than the
 * dormant threshold. Reuses the same `age > day` threshold the dataset
 * builder uses to mark runtimes as "dormant" so the UI/dataset semantics
 * stay consistent across the system.
 *
 * Hooks are fast-path; this is the always-correct backstop.
 */
export interface MemoSweepOptions {
    /** Directory holding per-conversation memo files. Defaults to ~/.nlm/hook-state/. */
    readonly stateDir?: string;
    /** Age threshold in ms beyond which a memo is swept. Default 24h (dormant). */
    readonly dormantMs?: number;
    /** Tick interval in ms. Default 5 min. */
    readonly intervalMs?: number;
    /** Defaults to console.error. Set to a noop in tests. */
    readonly logger?: (msg: string) => void;
    /** Override for time source — for deterministic tests. */
    readonly now?: () => number;
}
export interface SweepReport {
    readonly scanned: number;
    readonly deleted: number;
    readonly kept: number;
    readonly errors: number;
}
/**
 * One-shot sweep. Returns the report; safe to call from tests or one-off
 * CLI invocations without standing up the scheduler.
 */
export declare function sweepMemoDir(opts?: MemoSweepOptions): SweepReport;
/**
 * Periodic sweep loop. Mirrors ScanScheduler's start/stop shape so the
 * daemon can manage it the same way. First tick fires immediately on
 * start() — the daemon picking up after a long downtime should sweep
 * accumulated memos right away, not wait an interval.
 */
export declare class MemoSweepScheduler {
    private readonly opts;
    private stopped;
    private timer;
    constructor(opts?: MemoSweepOptions);
    start(): void;
    stop(): void;
    tick(): SweepReport;
    private scheduleNext;
}
