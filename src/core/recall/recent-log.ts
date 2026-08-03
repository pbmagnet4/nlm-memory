/**
 * recentLog — tail the query log for the /live observability panel.
 * Returns the last N entries in chronological order (most recent first).
 *
 * Path is tenant-derived (core/tenancy/tenant-state-path.ts), mirroring
 * query-log.ts (same underlying file): the default team's log is
 * $NLM_QUERY_LOG or ~/.nlm/query_log.jsonl; every other tenant reads
 * ~/.nlm/tenants/<tenantId>/query_log.jsonl and ignores the env override.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

export interface RecentLogEntry {
  readonly ts: string;
  readonly source: string;
  readonly runtime: string | null;
  readonly query: string | null;
  readonly entity: string | null;
  readonly kind: string | null;
  readonly mode: string;
  readonly limit: number;
  readonly nResults: number;
  readonly returnedIds: ReadonlyArray<string>;
}

function defaultLogPath(tenantId: string): string {
  if (tenantId === DEFAULT_TEAM_ID) {
    return process.env["NLM_QUERY_LOG"] ?? tenantStatePath(tenantId, "query_log.jsonl");
  }
  return tenantStatePath(tenantId, "query_log.jsonl");
}

const TAIL_BYTES = 256 * 1024;

export function recentQueryLog(
  tenantId: string,
  limit: number,
  logPath: string = defaultLogPath(tenantId),
): RecentLogEntry[] {
  if (!existsSync(logPath)) return [];
  const size = statSync(logPath).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const tail = readFileSync(logPath, { encoding: "utf8" }).slice(start);

  const entries: RecentLogEntry[] = [];
  for (const line of tail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      entries.push({
        ts: typeof raw["ts"] === "string" ? raw["ts"] : "",
        source: typeof raw["source"] === "string" ? raw["source"] : "unknown",
        runtime: typeof raw["runtime"] === "string" ? raw["runtime"] : null,
        query: typeof raw["query"] === "string" ? raw["query"] : null,
        entity: typeof raw["entity"] === "string" ? raw["entity"] : null,
        kind: typeof raw["kind"] === "string" ? raw["kind"] : null,
        mode: typeof raw["mode"] === "string" ? raw["mode"] : "keyword",
        limit: typeof raw["limit"] === "number" ? raw["limit"] : 0,
        nResults: typeof raw["n_results"] === "number" ? raw["n_results"] : 0,
        returnedIds: Array.isArray(raw["returned_ids"])
          ? raw["returned_ids"].filter((x): x is string => typeof x === "string")
          : [],
      });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => b.ts.localeCompare(a.ts));
  return entries.slice(0, limit);
}
