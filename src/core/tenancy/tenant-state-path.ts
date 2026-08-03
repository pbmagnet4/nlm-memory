/**
 * Path derivation for the shared file-state modules (hook memo, hook log,
 * query/citation/miss logs — the JSONL/JSON telemetry that predates
 * per-tenant SQLite rows). The default team's paths are byte-identical to
 * the pre-M6 layout (~/.nlm/<segments>); every other tenant is isolated
 * under ~/.nlm/tenants/<sanitized-tenantId>/<same segments>, so file state
 * stops leaking across tenants the way a shared ~/.nlm/query_log.jsonl did.
 *
 * Sanitization mirrors the conversation-id rule in core/hook/memo.ts:
 * [^A-Za-z0-9_-] -> "_", with "unknown" as the fallback for an id that
 * sanitizes to nothing.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "./default-team.js";

export const TENANTS_DIRNAME = "tenants";

function sanitizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}

/** ~/.nlm/<segments> for the default team; ~/.nlm/tenants/<t>/<segments> otherwise. */
export function tenantStatePath(tenantId: string, ...segments: string[]): string {
  const base = join(homedir(), ".nlm");
  if (tenantId === DEFAULT_TEAM_ID) return join(base, ...segments);
  return join(base, TENANTS_DIRNAME, sanitizeTenantId(tenantId), ...segments);
}
