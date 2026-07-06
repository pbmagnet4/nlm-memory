import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeScopePath } from "./derive-scope.js";

export type AliasMap = {
  named: Array<{ scope: string; paths: string[] }>;
  global: string[];
};

let cached: AliasMap | null = null;

function parseRaw(raw: string): AliasMap {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const named: Array<{ scope: string; paths: string[] }> = [];
  const global: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (!Array.isArray(val)) continue;
    const paths = val
      .filter((p): p is string => typeof p === "string")
      .map(normalizeScopePath);
    if (key === "global") {
      global.push(...paths);
    } else {
      named.push({ scope: key, paths });
    }
  }
  return { named, global };
}

export function loadAliasMap(path = join(homedir(), ".nlm", "scopes.json")): AliasMap {
  if (cached !== null) return cached;
  try {
    const raw = readFileSync(path, "utf8");
    cached = parseRaw(raw);
  } catch {
    cached = { named: [], global: [] };
  }
  return cached;
}

/** Test-only: drop the process memo so a fresh path is read. */
export function resetAliasMapCache(): void {
  cached = null;
}
