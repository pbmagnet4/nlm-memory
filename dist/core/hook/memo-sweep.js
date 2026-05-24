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
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Mirrors the dormant threshold in build-dataset.ts:
//   age <= hour  → "active"
//   age <= day   → "idle"
//   age > day    → "dormant"
// We sweep memos that are dormant.
const DEFAULT_DORMANT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
function defaultStateDir() {
    return process.env["NLM_HOOK_STATE_DIR"] ?? join(homedir(), ".nlm", "hook-state");
}
/**
 * One-shot sweep. Returns the report; safe to call from tests or one-off
 * CLI invocations without standing up the scheduler.
 */
export function sweepMemoDir(opts = {}) {
    const stateDir = opts.stateDir ?? defaultStateDir();
    const dormantMs = opts.dormantMs ?? DEFAULT_DORMANT_MS;
    const now = opts.now ?? Date.now;
    const logger = opts.logger ?? ((msg) => console.error(msg));
    if (!existsSync(stateDir)) {
        return { scanned: 0, deleted: 0, kept: 0, errors: 0 };
    }
    let entries;
    try {
        entries = readdirSync(stateDir);
    }
    catch (e) {
        logger(`[memo-sweep] readdir failed for ${stateDir}: ${e instanceof Error ? e.message : String(e)}`);
        return { scanned: 0, deleted: 0, kept: 0, errors: 1 };
    }
    const cutoff = now() - dormantMs;
    let deleted = 0;
    let kept = 0;
    let errors = 0;
    for (const name of entries) {
        if (!name.endsWith(".json")) {
            // Don't touch files we don't own (kept silently, don't even count).
            continue;
        }
        const path = join(stateDir, name);
        try {
            const stat = statSync(path);
            if (stat.mtimeMs < cutoff) {
                rmSync(path);
                deleted += 1;
            }
            else {
                kept += 1;
            }
        }
        catch (e) {
            errors += 1;
            logger(`[memo-sweep] failed on ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { scanned: deleted + kept + errors, deleted, kept, errors };
}
/**
 * Periodic sweep loop. Mirrors ScanScheduler's start/stop shape so the
 * daemon can manage it the same way. First tick fires immediately on
 * start() — the daemon picking up after a long downtime should sweep
 * accumulated memos right away, not wait an interval.
 */
export class MemoSweepScheduler {
    opts;
    stopped = true;
    timer = null;
    constructor(opts = {}) {
        this.opts = {
            stateDir: opts.stateDir,
            dormantMs: opts.dormantMs ?? DEFAULT_DORMANT_MS,
            intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
            logger: opts.logger ?? ((msg) => console.error(msg)),
            now: opts.now,
        };
    }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        this.scheduleNext(0);
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    tick() {
        return sweepMemoDir({
            dormantMs: this.opts.dormantMs,
            logger: this.opts.logger,
            ...(this.opts.stateDir !== undefined ? { stateDir: this.opts.stateDir } : {}),
            ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
        });
    }
    scheduleNext(delayMs) {
        if (this.stopped)
            return;
        this.timer = setTimeout(() => {
            try {
                this.tick();
            }
            catch (e) {
                this.opts.logger(`[memo-sweep] tick crashed: ${e instanceof Error ? e.message : String(e)}`);
            }
            this.scheduleNext(this.opts.intervalMs);
        }, delayMs);
        // Don't keep the event loop alive just for the sweep.
        if (this.timer && typeof this.timer.unref === "function")
            this.timer.unref();
    }
}
//# sourceMappingURL=memo-sweep.js.map