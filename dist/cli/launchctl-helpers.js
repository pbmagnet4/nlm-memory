/**
 * Pure helpers for parsing launchctl interactions.
 *
 * Extracted so the string-matching against launchctl's textual output can
 * be unit-tested. The real launchctl process invocations live in nlm.ts
 * where they're called.
 */
import { execFileSync } from "node:child_process";
/**
 * True when launchctl's bootout stderr indicates the agent simply wasn't
 * loaded — a benign condition during uninstall (we wanted it gone, it's
 * already gone). Any other error means something we should surface.
 *
 * The exact strings come from observed macOS launchctl output across
 * versions; match case-insensitively because phrasing varies.
 */
export function isBenignBootoutError(stderr) {
    const s = stderr.toLowerCase();
    return (s.includes("could not find service") ||
        s.includes("no such process") ||
        s.includes("not currently loaded"));
}
/**
 * True when the named LaunchAgent label appears in `launchctl list`. This
 * is the source of truth for "is the agent actually loaded right now" —
 * more reliable than trusting bootout's exit code, which has been seen to
 * return zero while leaving the daemon running and to return non-zero
 * while successfully unloading.
 *
 * Injected `runner` keeps this testable without spawning a real process.
 */
export function isAgentLoaded(label, runner = () => execFileSync("launchctl", ["list"], { stdio: "pipe", encoding: "utf8" })) {
    let out;
    try {
        out = runner();
    }
    catch {
        return false;
    }
    return out.split("\n").some((line) => line.includes(label));
}
//# sourceMappingURL=launchctl-helpers.js.map