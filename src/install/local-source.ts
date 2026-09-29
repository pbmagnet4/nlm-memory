/**
 * `nlm connect <runtime>` for runtimes NLM reads in place (OpenCode's
 * opencode.db, Muse's session store): nothing is installed, the connect
 * operation only registers the source row so the daemon scans it.
 */

import { existsSync } from "node:fs";
import type { SourceKind, SourceRegistryPort } from "../core/sources/source-registry.js";

export interface LocalSourceSpec {
  readonly kind: SourceKind;
  readonly name: string;
  readonly runtimeLabel: string;
  readonly path: string;
}

export interface ConnectLocalSourceReport {
  readonly path: string;
  readonly exists: boolean;
  readonly action: "created" | "enabled" | "already-active" | "dry-run";
}

export async function connectLocalSource(
  registry: SourceRegistryPort,
  tenantId: string,
  spec: LocalSourceSpec,
  opts: { dryRun?: boolean } = {},
): Promise<ConnectLocalSourceReport> {
  const exists = existsSync(spec.path);
  if (opts.dryRun) return { path: spec.path, exists, action: "dry-run" };

  const existing = await registry.getByName(tenantId, spec.name);
  if (existing) {
    if (existing.enabled && existing.pathOrUrl === spec.path) {
      return { path: spec.path, exists, action: "already-active" };
    }
    await registry.update(tenantId, existing.id, { enabled: true, pathOrUrl: spec.path });
    return { path: spec.path, exists, action: "enabled" };
  }

  await registry.insert(tenantId, {
    kind: spec.kind,
    name: spec.name,
    pathOrUrl: spec.path,
    runtimeLabel: spec.runtimeLabel,
    enabled: exists,
  });
  return { path: spec.path, exists, action: "created" };
}
