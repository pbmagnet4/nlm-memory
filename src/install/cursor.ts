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
import type { SourceRegistryPort } from "../core/sources/source-registry.js";

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

export async function connectCursor(
  registry: SourceRegistryPort,
  opts: ConnectCursorOptions = {},
): Promise<ConnectCursorReport> {
  const adapterDbPath = opts.dbPath ?? defaultDbPath();
  const adapterExists = existsSync(adapterDbPath);

  if (opts.dryRun) {
    return { adapterDbPath, adapterExists, action: "dry-run" };
  }

  const existing = await registry.getByName("Cursor");
  if (existing) {
    if (existing.enabled && existing.pathOrUrl === adapterDbPath) {
      return { adapterDbPath, adapterExists, action: "already-active" };
    }
    await registry.update(existing.id, { enabled: true, pathOrUrl: adapterDbPath });
    return { adapterDbPath, adapterExists, action: "enabled" };
  }

  await registry.insert({
    kind: "cursor",
    name: "Cursor",
    pathOrUrl: adapterDbPath,
    runtimeLabel: "cursor/1.0",
    enabled: adapterExists,
  });
  return { adapterDbPath, adapterExists, action: "created" };
}

export async function disconnectCursor(
  registry: SourceRegistryPort,
  opts: { dryRun?: boolean } = {},
): Promise<DisconnectCursorReport> {
  if (opts.dryRun) return { action: "dry-run" };
  const existing = await registry.getByName("Cursor");
  if (!existing) return { action: "not-found" };
  await registry.update(existing.id, { enabled: false });
  return { action: "disabled" };
}
