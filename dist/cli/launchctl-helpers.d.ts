/**
 * Pure helpers for parsing launchctl interactions.
 *
 * Extracted so the string-matching against launchctl's textual output can
 * be unit-tested. The real launchctl process invocations live in nlm.ts
 * where they're called.
 */
/**
 * True when launchctl's bootout stderr indicates the agent simply wasn't
 * loaded — a benign condition during uninstall (we wanted it gone, it's
 * already gone). Any other error means something we should surface.
 *
 * The exact strings come from observed macOS launchctl output across
 * versions; match case-insensitively because phrasing varies.
 */
export declare function isBenignBootoutError(stderr: string): boolean;
/**
 * True when the named LaunchAgent label appears in `launchctl list`. This
 * is the source of truth for "is the agent actually loaded right now" —
 * more reliable than trusting bootout's exit code, which has been seen to
 * return zero while leaving the daemon running and to return non-zero
 * while successfully unloading.
 *
 * Injected `runner` keeps this testable without spawning a real process.
 */
export declare function isAgentLoaded(label: string, runner?: () => string): boolean;
