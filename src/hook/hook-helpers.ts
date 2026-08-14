import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * "Am I the entry point?" for a hook module, tolerant of symlinked installs.
 *
 * Node realpath-resolves `import.meta.url` but leaves `process.argv[1]` as the
 * literal string the caller passed. Comparing them directly means any
 * symlinked path fails the check, main() never runs, and the hook exits 0
 * having silently done nothing. A versioned install with a `current` ->
 * versions/X pointer invokes hooks through exactly such a symlink, so the
 * naive comparison disables session capture while still reporting success.
 *
 * Resolving argv[1] before comparing makes the two agree in both layouts.
 * A nonexistent argv[1] is not an error here — it just isn't us.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let resolved: string;
  try {
    resolved = realpathSync(argv1);
  } catch {
    return false;
  }
  return metaUrl === pathToFileURL(resolved).href;
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function hookModeFromEnv(): "shadow" | "live" {
  return process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
}

export function appendHookEvent(data: Record<string, unknown>): void {
  try {
    const path = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(data)}\n`, "utf8");
  } catch {
    // Telemetry failure must never break the hook.
  }
}
