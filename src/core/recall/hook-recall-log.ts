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

/**
 * The last `maxBytes` of the hook log as text, with the leading partial line
 * dropped (a tail read starts mid-record). Both synchronous readers use it —
 * hub damping (T1783) and the nightly relevance sampler (T1782) — because both
 * have to bound what they read: the log is append-only and carries every fire,
 * and neither may slurp it, least of all in the hook's hot path or inside a
 * scheduler slice. A cap smaller than a day of traffic is normal and intended;
 * a reader then covers less history, which is the safe direction for both.
 *
 * Returns "" for a missing or unreadable file, and for a cap that does not
 * contain one whole line — never a half-parsed record. `\n` is never part of a
 * multi-byte UTF-8 sequence, so cutting there is byte-safe.
 */
export function readTailText(logPath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const cap = Math.min(size, maxBytes);
    const from = size - cap;
    const buf = Buffer.allocUnsafe(cap);
    const read = readSync(fd, buf, 0, cap, from);
    const text = buf.toString("utf8", 0, read);
    if (from === 0) return text;
    const firstNl = text.indexOf("\n");
    return firstNl === -1 ? "" : text.slice(firstNl + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
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
 * Hub damping input (T1783): id -> number of DISTINCT prompt previews its
 * wouldInject appearances span in the last `days` (a recurring automation
 * prompt re-firing the same recall collapses into one). Hot-path hook use,
 * so it is synchronous and reads only the LAST `maxBytes` of the log
 * (`readTailText`, not a full parse) — if the window reaches past the cap the
 * counts under-count, which only weakens the penalty, the safe direction.
 * Entries without a promptPreview all key to the empty preview, i.e. spread 1 —
 * conservative, never inflates the penalty. Fail-open: a missing or unreadable
 * log counts nothing, which is no penalty at all — the pre-T1783 behaviour —
 * and an unparsable line is skipped instead of aborting the count.
 *
 * Counts fixture/e2e fires too (they share the file); they only ever
 * broaden ids from fixture corpora, which the live corpus never recalls.
 */
export function countRecentInjectionPrompts(
  days: number,
  logPath: string = hookLogPath(DEFAULT_TEAM_ID),
  maxBytes = 4 * 1024 * 1024,
): ReadonlyMap<string, number> {
  const previews = new Map<string, Set<string>>();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const line of readTailText(logPath, maxBytes).split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(obj["wouldInject"])) continue;
    if (typeof obj["ts"] !== "string" || Date.parse(obj["ts"]) < cutoff) continue;
    const preview = typeof obj["promptPreview"] === "string" ? obj["promptPreview"].slice(0, 80) : "";
    for (const id of obj["wouldInject"]) {
      if (typeof id !== "string") continue;
      let set = previews.get(id);
      if (!set) {
        set = new Set();
        previews.set(id, set);
      }
      set.add(preview);
    }
  }
  const counts = new Map<string, number>();
  for (const [id, set] of previews) counts.set(id, set.size);
  return counts;
}
