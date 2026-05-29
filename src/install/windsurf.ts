/**
 * `nlm connect windsurf` / `nlm disconnect windsurf` — registers or removes the
 * Windsurf adapter source in the NLM source registry.
 *
 * NLM reads Windsurf's existing workspace SQLite DBs directly from the User
 * directory. The connect operation only registers the source row so the daemon
 * scans it.
 */

import { existsSync } from "node:fs";
import { defaultUserDir } from "../core/adapters/windsurf.js";
import type { SourceRegistry } from "../core/sources/source-registry.js";

export interface ConnectWindsurfOptions {
  readonly userDir?: string;
  readonly dryRun?: boolean;
}

export interface ConnectWindsurfReport {
  readonly userDir: string;
  readonly dirExists: boolean;
  readonly action: "created" | "enabled" | "already-active" | "dry-run";
}

export interface DisconnectWindsurfReport {
  readonly action: "disabled" | "not-found" | "dry-run";
}

export function connectWindsurf(
  registry: SourceRegistry,
  opts: ConnectWindsurfOptions = {},
): ConnectWindsurfReport {
  const userDir = opts.userDir ?? defaultUserDir();
  const dirExists = existsSync(userDir);

  if (opts.dryRun) {
    return { userDir, dirExists, action: "dry-run" };
  }

  const existing = registry.getByName("Windsurf");
  if (existing) {
    if (existing.enabled && existing.pathOrUrl === userDir) {
      return { userDir, dirExists, action: "already-active" };
    }
    registry.update(existing.id, { enabled: true, pathOrUrl: userDir });
    return { userDir, dirExists, action: "enabled" };
  }

  registry.insert({
    kind: "windsurf",
    name: "Windsurf",
    pathOrUrl: userDir,
    runtimeLabel: "windsurf/1.0",
    enabled: dirExists,
  });
  return { userDir, dirExists, action: "created" };
}

export function disconnectWindsurf(
  registry: SourceRegistry,
  opts: { dryRun?: boolean } = {},
): DisconnectWindsurfReport {
  if (opts.dryRun) return { action: "dry-run" };
  const existing = registry.getByName("Windsurf");
  if (!existing) return { action: "not-found" };
  registry.update(existing.id, { enabled: false });
  return { action: "disabled" };
}
