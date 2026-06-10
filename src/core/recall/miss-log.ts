/**
 * Append-only JSONL miss log. One line per session the agent explicitly
 * fetched or cited but which the hook's pre-prompt recall never surfaced
 * in this conversation. Source: Stop hook's miss-detection pass (spec E).
 *
 * Default path ~/.nlm/miss-log.jsonl, overridable via NLM_MISS_LOG.
 * Disable emission entirely with NLM_MISS_LOG_ENABLED=0 — used by
 * deployments that want recall but not telemetry. Telemetry path — never
 * raises; failure to write is silently swallowed.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MissKind = "get_session" | "cite_session";

export interface MissEntry {
  readonly conversationId: string;
  readonly missedId: string;
  readonly kind: MissKind;
  /**
   * Count of how many sessions WERE surfaced this conversation. Helps
   * distinguish "hook never fired" (surfacedCount=0) from "hook fired but
   * missed this one" (surfacedCount>0). Aggregation can filter accordingly.
   */
  readonly surfacedCount: number;
}

export interface MissStats {
  readonly days: number;
  readonly total: number;
  readonly distinctIds: number;
  /** Top missed sessions ordered by miss count, with diagnostic context. */
  readonly topIds: ReadonlyArray<{
    readonly id: string;
    readonly count: number;
    readonly conversations: number;
  }>;
  readonly logPresent: boolean;
}

function defaultLogPath(): string {
  return process.env["NLM_MISS_LOG"] ?? join(homedir(), ".nlm", "miss-log.jsonl");
}

function isEnabled(): boolean {
  const raw = process.env["NLM_MISS_LOG_ENABLED"];
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export async function appendMiss(entry: MissEntry, logPath?: string): Promise<void> {
  if (!isEnabled()) return;
  const path = logPath ?? defaultLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    })}\n`;
    await appendFile(path, line, "utf8");
  } catch {
    // Telemetry must never break recall.
  }
}

/**
 * Append multiple misses in one call. Each gets the same timestamp.
 * Quieter than appendMiss × N when several misses fire in a single Stop
 * hook invocation (which is the common case).
 */
export async function appendMisses(
  entries: ReadonlyArray<MissEntry>,
  logPath?: string,
): Promise<void> {
  if (!isEnabled()) return;
  if (entries.length === 0) return;
  const path = logPath ?? defaultLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const ts = new Date().toISOString();
    const block = entries.map((e) => `${JSON.stringify({ ts, ...e })}\n`).join("");
    await appendFile(path, block, "utf8");
  } catch {
    // Swallow.
  }
}

/**
 * Read the miss log and aggregate by missedId. Used by the `nlm misses`
 * CLI. Days filter applied at parse time. Bad lines (non-JSON or missing
 * fields) are skipped silently.
 */
export async function missStats(
  days: number,
  logPath?: string,
): Promise<MissStats> {
  const path = logPath ?? defaultLogPath();
  try {
    await stat(path);
  } catch {
    return { days, total: 0, distinctIds: 0, topIds: [], logPresent: false };
  }
  const raw = await readFile(path, "utf8");
  const cutoff = Date.now() - days * 86_400_000;
  type Row = { ts: string; conversationId: string; missedId: string };
  const counts = new Map<string, { count: number; convs: Set<string> }>();
  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: Partial<Row>;
    try {
      parsed = JSON.parse(line) as Partial<Row>;
    } catch {
      continue;
    }
    if (!parsed.ts || !parsed.missedId || !parsed.conversationId) continue;
    if (Date.parse(parsed.ts) < cutoff) continue;
    total += 1;
    let bucket = counts.get(parsed.missedId);
    if (!bucket) {
      bucket = { count: 0, convs: new Set() };
      counts.set(parsed.missedId, bucket);
    }
    bucket.count += 1;
    bucket.convs.add(parsed.conversationId);
  }
  const topIds = [...counts.entries()]
    .map(([id, b]) => ({ id, count: b.count, conversations: b.convs.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  return {
    days,
    total,
    distinctIds: counts.size,
    topIds,
    logPresent: true,
  };
}
