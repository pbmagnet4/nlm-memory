/**
 * Per-conversation dedup memo for the Stop hook's citation detector.
 *
 * The Stop hook scans the full transcript every fire, so a long conversation
 * with repeated Stop firings would otherwise re-detect the same tool_use
 * citations every turn and double-count them in the citation log. This memo
 * holds the set of (conversationId, citedId) pairs already posted, so each
 * citation lands exactly once regardless of how many times Stop fires.
 *
 * Storage parallels the surfaced-memo (`memo.ts`): same tenant-derived state
 * directory (core/tenancy/tenant-state-path.ts) — the default team's dir is
 * `~/.nlm/hook-state/`, overridable via NLM_HOOK_STATE_DIR; every other
 * tenant is isolated under `~/.nlm/tenants/<tenantId>/hook-state/` and
 * ignores the env override. Filename suffix `.cited.json` distinguishes this
 * memo from the surfaced memo's `.json` within the same directory. The
 * existing memo-sweep walks the default team's directory by mtime and cleans
 * both files together.
 *
 * Defensive: a missing or corrupt file yields an empty set; a write failure
 * is swallowed. Telemetry path — must never break the hook.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

function stateDir(tenantId: string): string {
  if (tenantId === DEFAULT_TEAM_ID) {
    return process.env["NLM_HOOK_STATE_DIR"] ?? tenantStatePath(tenantId, "hook-state");
  }
  return tenantStatePath(tenantId, "hook-state");
}

function memoPath(tenantId: string, conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(tenantId), `${safe}.cited.json`);
}

export function loadCited(tenantId: string, conversationId: string): Set<string> {
  try {
    const path = memoPath(tenantId, conversationId);
    if (!existsSync(path)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function recordCited(
  tenantId: string,
  conversationId: string,
  ids: ReadonlyArray<string>,
): void {
  if (ids.length === 0) return;
  try {
    const merged = loadCited(tenantId, conversationId);
    for (const id of ids) merged.add(id);
    mkdirSync(stateDir(tenantId), { recursive: true });
    writeFileSync(memoPath(tenantId, conversationId), JSON.stringify([...merged]), "utf8");
  } catch {
    // Memo write failure must never break the hook.
  }
}

export function clearCited(tenantId: string, conversationId: string): boolean {
  try {
    const path = memoPath(tenantId, conversationId);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
