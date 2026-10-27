import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { normalizeScopePath } from "@core/scope/derive-scope.js";
import type { MemoryProperty } from "./model.js";

const identities = new Map<string, string | null>();
function gitIdentity(directory: string, cache = false): string | null {
  if (cache && identities.has(directory)) return identities.get(directory)!;
  let identity: string | null = null;
  try {
    identity = normalizeScopePath(execFileSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim());
  } catch { /* A captured directory can belong to a different machine or no repository. */ }
  if (cache && identity !== null) identities.set(directory, identity);
  return identity;
}
export function repositoryProperty(directory: string | undefined, catalog: readonly MemoryProperty[]): string | null {
  if (!directory || !isAbsolute(directory)) return null;
  const identity = gitIdentity(directory);
  const path = normalizeScopePath(directory);
  const matches = catalog.filter((p) => p.repositories.some((repository) => {
    if (!isAbsolute(repository)) return false;
    if (identity !== null) return gitIdentity(repository, true) === identity;
    const prefix = normalizeScopePath(repository);
    return path === prefix || path.startsWith(prefix + "/");
  }));
  return matches.length === 1 ? matches[0]!.slug : null;
}
