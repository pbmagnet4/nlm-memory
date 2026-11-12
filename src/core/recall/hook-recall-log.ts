/**
 * Reader for the prompt-recall hook's surfaced-set entries in
 * ~/.nlm/hook-log.jsonl. Unlike query_log.jsonl, hook-log entries reliably
 * carry the real conversationId (Claude Code session_id) alongside the
 * injected ids — making it the correct join substrate for recall precision.
 *
 * Only `recall` entries (those with a wouldInject array) are surfaced events.
 * The file also holds stop / session-end / pre-compact entries, which this
 * reader ignores.
 *
 * Path is tenant-derived (core/tenancy/tenant-state-path.ts): the default
 * team reads $NLM_HOOK_LOG or ~/.nlm/hook-log.jsonl; every other tenant
 * reads ~/.nlm/tenants/<tenantId>/hook-log.jsonl and ignores the env
 * override. Read-only telemetry path — never raises.
 */

import { readFile } from "node:fs/promises";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

export interface HookRecallEntry {
  readonly conversationId: string;
  readonly injectedIds: ReadonlyArray<string>;
}

/** Same resolution the readers use: $NLM_HOOK_LOG for the default team, tenant path otherwise. */
export function hookLogPath(tenantId: string): string {
  if (tenantId === DEFAULT_TEAM_ID) {
    return process.env["NLM_HOOK_LOG"] ?? tenantStatePath(tenantId, "hook-log.jsonl");
  }
  return tenantStatePath(tenantId, "hook-log.jsonl");
}

function defaultLogPath(tenantId: string): string {
  return hookLogPath(tenantId);
}

export async function readHookRecallLog(
  tenantId: string,
  days: number,
  logPath: string = defaultLogPath(tenantId),
): Promise<HookRecallEntry[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: HookRecallEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(obj["wouldInject"])) continue;
    if (typeof obj["ts"] !== "string" || Date.parse(obj["ts"]) < cutoff) continue;
    const conversationId = typeof obj["conversationId"] === "string" ? obj["conversationId"] : "unknown";
    if (conversationId === "unknown") continue;
    const injectedIds = obj["wouldInject"].filter((x): x is string => typeof x === "string");
    if (injectedIds.length === 0) continue;
    results.push({ conversationId, injectedIds });
  }
  return results;
}

/**
 * Hub damping input (T1783): id -> number of wouldInject appearances in the
 * last `days`. Hot-path hook use, so it is synchronous and reads only the
 * LAST `maxBytes` of the log (a tail seek, not a full parse) — if the window
 * reaches past the cap the counts under-count, which only weakens the
 * penalty, the safe direction. Fail-open: any I/O or parse trouble yields
 * whatever accumulated before it, or an empty map.
 *
 * Counts fixture/e2e fires too (they share the file); they only ever inflate
 * ids from fixture corpora, which the live corpus never recalls.
 */
export function countRecentInjections(
  days: number,
  logPath: string = hookLogPath(DEFAULT_TEAM_ID),
  maxBytes = 4 * 1024 * 1024,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const cap = Math.min(size, maxBytes);
    const from = size - cap;
    const buf = Buffer.allocUnsafe(cap);
    readSync(fd, buf, 0, cap, from);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const lines = buf.toString("utf8").split("\n");
    if (from > 0) lines.shift(); // partial first line — discard, not corrupt-count
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!Array.isArray(obj["wouldInject"])) continue;
      if (typeof obj["ts"] !== "string" || Date.parse(obj["ts"]) < cutoff) continue;
      for (const id of obj["wouldInject"]) {
        if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  } catch {
    // Fail-open: no counts means no penalty — the pre-T1783 behavior.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  return counts;
}
