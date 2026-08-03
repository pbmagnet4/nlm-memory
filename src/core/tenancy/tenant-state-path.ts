/**
 * Path derivation for the shared file-state modules (hook memo, hook log,
 * query/citation/miss logs — the JSONL/JSON telemetry that predates
 * per-tenant SQLite rows). The default team's paths are byte-identical to
 * the pre-M6 layout (~/.nlm/<segments>); every other tenant is isolated
 * under ~/.nlm/tenants/<sanitized-tenantId>/<same segments>, so file state
 * stops leaking across tenants the way a shared ~/.nlm/query_log.jsonl did.
 *
 * Sanitization mirrors the conversation-id rule in core/hook/memo.ts
 * ([^A-Za-z0-9_-] -> "_", with "unknown" as the fallback for an id that
 * sanitizes to nothing) but is not injective on its own — "acme.co" and
 * "acme_co" both sanitize to "acme_co", which would collide the two
 * tenants' directories. An id already safe (matches [A-Za-z0-9_-]+) is used
 * as-is; any other id gets the sanitized form plus an 8-hex-char sha256
 * digest of the *raw* (pre-sanitization) id appended, so two ids that
 * collide after sanitization always land in distinct directories.
 *
 * NLM_STATE_ROOT overrides the ~/.nlm base directory for every tenant,
 * default team included (the two branches below share the same `base`).
 * This is a root move, not a per-tenant redirect: it does not reintroduce
 * the leak the per-file overrides (NLM_QUERY_LOG et al., which apply to the
 * default team's file only) were scoped away from — every tenant's
 * directory keeps moving together under the new root, so isolation between
 * tenants is unaffected. Test-only; production leaves it unset.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "./default-team.js";

export const TENANTS_DIRNAME = "tenants";

const SAFE_TENANT_ID = /^[A-Za-z0-9_-]+$/;

function sanitizeTenantId(tenantId: string): string {
  if (SAFE_TENANT_ID.test(tenantId)) return tenantId;
  const sanitized = tenantId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  const hash = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  return `${sanitized}_${hash}`;
}

function stateRoot(): string {
  return process.env["NLM_STATE_ROOT"] || join(homedir(), ".nlm");
}

/** ~/.nlm/<segments> for the default team; ~/.nlm/tenants/<t>/<segments> otherwise. */
export function tenantStatePath(tenantId: string, ...segments: string[]): string {
  const base = stateRoot();
  if (tenantId === DEFAULT_TEAM_ID) return join(base, ...segments);
  return join(base, TENANTS_DIRNAME, sanitizeTenantId(tenantId), ...segments);
}
