/**
 * Hook version parity — companion to the hook-liveness canary.
 *
 * hook-liveness.ts answers "did hooks fire?". It structurally cannot answer
 * "did the RIGHT hooks fire?", so a hook executing stale code out of some other
 * install passes it cleanly. On 2026-08-14 that gap hid a real regression for
 * nine days: the five Claude Code hooks ran a 0.21.0 build from a dev checkout
 * while the daemon served 0.21.3, and every existing check stayed green,
 * because firing and being-current are different properties.
 *
 * Hooks stamp their own version into each hook-log entry (`v`). This compares
 * the most recent LIVE fire against the version the daemon/CLI expects.
 *
 * Reading only the newest live fire is deliberate. Scanning a window would
 * keep alerting for a day after every legitimate upgrade, because the window
 * still contains pre-upgrade entries — and an alert that cries wolf after
 * routine upgrades gets muted, which is how the original drift survived. The
 * newest fire self-clears the moment an upgraded hook runs once, while a hook
 * that really is stale keeps reporting the old version indefinitely.
 *
 * A newest fire with no `v` at all is treated as a mismatch, not as missing
 * data: hooks that predate the stamp are, by definition, the stale build this
 * check exists to catch.
 */

export interface VersionedHookLogEntry {
  readonly ts?: string;
  readonly mode?: string;
  /** Hook's own version, stamped at write time. Absent on pre-stamp builds. */
  readonly v?: string;
}

export function checkHookVersionParity(
  hookLog: ReadonlyArray<VersionedHookLogEntry>,
  expectedVersion: string | undefined,
): string | null {
  if (!expectedVersion) return null;

  let newest: VersionedHookLogEntry | null = null;
  let newestTs = -Infinity;
  for (const entry of hookLog) {
    if (entry.mode !== "live") continue;
    const ts = entry.ts ? Date.parse(entry.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts > newestTs) {
      newestTs = ts;
      newest = entry;
    }
  }

  // No live fires at all is liveness's alert to raise, not this one.
  if (!newest) return null;

  if (!newest.v) {
    return (
      `WARN hook version unknown: the most recent live hook fire reports no ` +
      `version, so it predates the parity stamp and is running an older build ` +
      `than ${expectedVersion} — check the hook commands in ~/.claude/settings.json`
    );
  }

  if (newest.v !== expectedVersion) {
    return (
      `WARN hook version skew: hooks are running ${newest.v} but the install is ` +
      `${expectedVersion} — the hook commands in ~/.claude/settings.json point at ` +
      `a different build than the daemon`
    );
  }

  return null;
}
