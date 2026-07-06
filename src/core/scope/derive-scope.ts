import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { AliasMap } from "./alias-map.js";

/**
 * The one scope-path normalizer: symlink-resolved when the path exists,
 * lexical fallback otherwise. Inputs and configured alias prefixes MUST go
 * through the same function or a symlinked alias entry can mis-resolve.
 */
export function normalizeScopePath(p: string): string {
  let n: string;
  try {
    n = realpathSync(p);
  } catch {
    n = normalize(p);
  }
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function matchesPrefix(prefix: string, target: string): boolean {
  return target === prefix || target.startsWith(prefix + "/");
}

type Candidate = { prefix: string; scope: string; isGlobal: boolean };

export function deriveScope(path: string, aliasMap: AliasMap): string | null {
  if (!path || !isAbsolute(path)) return null;
  const norm = normalizeScopePath(path);

  const candidates: Candidate[] = [];

  for (const entry of aliasMap.named) {
    for (const prefix of entry.paths) {
      if (matchesPrefix(prefix, norm)) {
        candidates.push({ prefix, scope: entry.scope, isGlobal: false });
      }
    }
  }
  for (const prefix of aliasMap.global) {
    if (matchesPrefix(prefix, norm)) {
      candidates.push({ prefix, scope: "global", isGlobal: true });
    }
  }

  if (candidates.length === 0) return norm;

  candidates.sort((a, b) => {
    const lenDiff = b.prefix.length - a.prefix.length;
    if (lenDiff !== 0) return lenDiff;
    if (!a.isGlobal && b.isGlobal) return -1;
    if (a.isGlobal && !b.isGlobal) return 1;
    // Deterministic across scopes.json key orderings when two named scopes
    // claim equal-length prefixes (a config error, but it must not flap).
    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
  });

  return candidates[0]!.scope;
}
