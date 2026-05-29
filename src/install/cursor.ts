/**
 * `nlm connect cursor` / `nlm disconnect cursor` — registers or removes the
 * Cursor adapter source in the NLM source registry.
 *
 * Unlike plugin-based runtimes (hermes-agent, codex), Cursor needs no file
 * to be installed. NLM reads Cursor's existing state.vscdb directly. The
 * connect operation only registers the source row so the daemon scans it.
 */

import { existsSync } from "node:fs";
import { defaultDbPath } from "../core/adapters/cursor.js";
import type { SourceRegistry } from "../core/sources/source-registry.js";

export interface ConnectCursorOptions {
  readonly dbPath?: string;
  readonly dryRun?: boolean;
}

export interface ConnectCursorReport {
  readonly adapterDbPath: string;
  readonly adapterExists: boolean;
  readonly action: "created" | "enabled" | "already-active" | "dry-run";
}

export interface DisconnectCursorReport {
  readonly action: "disabled" | "not-found" | "dry-run";
}

export function connectCursor(
  registry: SourceRegistry,
  opts: ConnectCursorOptions = {},
): ConnectCursorReport {
  const adapterDbPath = opts.dbPath ?? defaultDbPath();
  const adapterExists = existsSync(adapterDbPath);

  if (opts.dryRun) {
    return { adapterDbPath, adapterExists, action: "dry-run" };
  }

  const existing = registry.getByName("Cursor");
  if (existing) {
    if (existing.enabled && existing.pathOrUrl === adapterDbPath) {
      return { adapterDbPath, adapterExists, action: "already-active" };
    }
    registry.update(existing.id, { enabled: true, pathOrUrl: adapterDbPath });
    return { adapterDbPath, adapterExists, action: "enabled" };
  }

  registry.insert({
    kind: "cursor",
    name: "Cursor",
    pathOrUrl: adapterDbPath,
    runtimeLabel: "cursor/1.0",
    enabled: adapterExists,
  });
  return { adapterDbPath, adapterExists, action: "created" };
}

export function disconnectCursor(
  registry: SourceRegistry,
  opts: { dryRun?: boolean } = {},
): DisconnectCursorReport {
  if (opts.dryRun) return { action: "dry-run" };
  const existing = registry.getByName("Cursor");
  if (!existing) return { action: "not-found" };
  registry.update(existing.id, { enabled: false });
  return { action: "disabled" };
}
