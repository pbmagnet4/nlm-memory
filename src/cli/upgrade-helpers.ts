import { join } from "node:path";
import { homedir } from "node:os";

/**
 * True when the running process is a local dev build (not an npm global
 * install). Dev builds have `__filename` pointing inside a project
 * directory, not inside a `node_modules` tree.
 *
 * Injected `filename` keeps this testable without depending on the real
 * __filename at test time.
 */
export function isDevBuild(filename: string): boolean {
  return !filename.includes("node_modules");
}

/**
 * Absolute path to the update-check cache file. Mirrors the path logic
 * in src/core/update-check/check.ts so both sides bust the same file.
 */
export function updateCheckCachePath(): string {
  return (
    process.env["NLM_UPDATE_CHECK_CACHE"] ??
    join(homedir(), ".nlm", "update-check.json")
  );
}
