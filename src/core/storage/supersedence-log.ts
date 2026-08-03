/**
 * Append-only JSONL audit log for post-hoc supersedence mutations. One line
 * per `mark_superseded` MCP call (or future UI action). Atomic-on-insert
 * supersedence at ingest time is not logged here — that lineage is already
 * implicit in the session_edges row's predecessor reference.
 *
 * Path is tenant-derived (core/tenancy/tenant-state-path.ts): the default
 * team's log is ~/.nlm/supersedence-log.jsonl, overridable via
 * NLM_SUPERSEDENCE_LOG; every other tenant is isolated under
 * ~/.nlm/tenants/<tenantId>/supersedence-log.jsonl and ignores the env
 * override. Telemetry path — never raises, but on failure it emits one
 * warning line to stderr so a silent disk-full or permission issue doesn't
 * leave the operator believing their audit trail is intact.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

export interface SupersedenceEntry {
  readonly predecessorId: string;
  readonly successorId: string;
  readonly reason?: string;
  readonly source?: string;
}

function defaultLogPath(tenantId: string): string {
  if (tenantId === DEFAULT_TEAM_ID) {
    return process.env["NLM_SUPERSEDENCE_LOG"] ?? tenantStatePath(tenantId, "supersedence-log.jsonl");
  }
  return tenantStatePath(tenantId, "supersedence-log.jsonl");
}

/** Read all supersedence log entries. Never raises — returns [] on missing file. */
export async function readSupersedenceLog(
  tenantId: string,
  logPath: string = defaultLogPath(tenantId),
): Promise<
  ReadonlyArray<SupersedenceEntry & { ts: string; source?: string }>
> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    // Log file missing or unreadable - no supersedence history recovered.
    return [];
  }
  const results: Array<SupersedenceEntry & { ts: string; source?: string }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof obj["predecessor_id"] !== "string" ||
        typeof obj["successor_id"] !== "string"
      )
        continue;
      results.push({
        predecessorId: obj["predecessor_id"],
        successorId: obj["successor_id"],
        ts: typeof obj["ts"] === "string" ? obj["ts"] : "",
        ...(typeof obj["reason"] === "string" ? { reason: obj["reason"] } : {}),
        ...(typeof obj["source"] === "string" ? { source: obj["source"] } : {}),
      });
    } catch {
      // Malformed entry in log - skip and continue parsing.
      continue;
    }
  }
  return results;
}

export interface FactSupersedenceEntry {
  readonly factId: string;
  readonly reason?: string;
  readonly source?: string;
}

/** Append a fact-level supersedence event to the shared audit JSONL.
 *  Entries carry `kind: "fact"` so the session-scoped reader skips them. */
export async function appendFactSupersedence(
  tenantId: string,
  entry: FactSupersedenceEntry,
  logPath: string = defaultLogPath(tenantId),
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      kind: "fact",
      fact_id: entry.factId,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
    };
    await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `nlm-memory: failed to append fact-supersedence-log entry at ${logPath}: ${msg}\n`,
    );
  }
}

export async function appendSupersedence(
  tenantId: string,
  entry: SupersedenceEntry,
  logPath: string = defaultLogPath(tenantId),
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      predecessor_id: entry.predecessorId,
      successor_id: entry.successorId,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
    };
    await appendFile(logPath, JSON.stringify(payload) + "\n", "utf8");
  } catch (e) {
    // Telemetry failure must never break the call path, but surface the
    // problem so the operator can investigate (the supersedence itself
    // still committed to SQLite — only the audit row is missing).
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `nlm-memory: failed to append supersedence-log entry at ${logPath}: ${msg}\n`,
    );
  }
}
