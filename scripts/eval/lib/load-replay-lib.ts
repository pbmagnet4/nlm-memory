/**
 * Pure helpers for the load-replay eval (T1775b): replays real prompt-hook
 * traffic from the hook log against a daemon and scores it against the recall
 * SLOs (timeout rate < 2 %, recall p95 < 1000 ms). No I/O here — record
 * filtering, windowing, the replay schedule, percentiles and the report math
 * live in this file so they are fixture-testable apart from the HTTP shell.
 *
 * The report is counts and latencies only: prompt text never enters it.
 */

import { buildRecallQuery } from "../../../src/hook/prompt-recall-hook.js";
import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";
import { RECALL_QUERY_LOG_CHARS } from "../../../src/core/hook/hook-log.js";
import { RECALL_LIMIT } from "../../../src/hook/recall-over-http.js";

// ---------------------------------------------------------------------------
// Hook-log ingest (shape filter only — selection lives in selectWindow)
// ---------------------------------------------------------------------------

/** One replayable hook-log line: the prompt-recall gate=evaluate fires. */
export interface ReplayRecord {
  readonly ts: string;
  readonly tsMs: number;
  readonly conversationId: string;
  readonly promptPreview: string;
  /** The query the hook actually sent, once logged (T1775b); absent on older lines. */
  readonly recallQuery?: string;
  /** True when the hook cut recallQuery at the log budget — replays approximate. */
  readonly recallQueryTruncated?: boolean;
}

export interface HookLogParse {
  readonly records: ReadonlyArray<ReplayRecord>;
  /** Lines that were not JSON at all (or not JSON objects). */
  readonly malformed: number;
  /** Well-formed JSON lines rejected by the shape filter. */
  readonly skipped: number;
}

/**
 * Parses the hook log's JSONL. A replay record is a line with NO `kind`
 * field (stop/session-end/pre-compact events share this file), gate
 * "evaluate", a string promptPreview and a parseable string ts. Everything
 * else is skipped, never thrown — the log is append-only telemetry written
 * by many hook builds. Blank lines are padding, not malformation.
 */
export function parseHookLogLines(raw: string): HookLogParse {
  const records: ReplayRecord[] = [];
  let malformed = 0;
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed++;
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (
      row["kind"] !== undefined ||
      row["gate"] !== "evaluate" ||
      typeof row["promptPreview"] !== "string" ||
      typeof row["ts"] !== "string" ||
      Number.isNaN(Date.parse(row["ts"]))
    ) {
      skipped++;
      continue;
    }
    records.push({
      ts: row["ts"],
      tsMs: Date.parse(row["ts"]),
      conversationId: typeof row["conversationId"] === "string" ? row["conversationId"] : "unknown",
      promptPreview: row["promptPreview"],
      ...(typeof row["recallQuery"] === "string" && row["recallQuery"] !== ""
        ? {
            recallQuery: (row["recallQuery"] as string).slice(0, RECALL_QUERY_LOG_CHARS),
            // A cut here counts like a cut by the hook: the replay is approximate either way.
            ...(row["recallQueryTruncated"] === true || (row["recallQuery"] as string).length > RECALL_QUERY_LOG_CHARS
              ? { recallQueryTruncated: true } : {}),
          }
        : {}),
    });
  }
  return { records, malformed, skipped };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default window start: 24 h before the newest record. Null when there are none. */
export function defaultSinceMs(records: ReadonlyArray<ReplayRecord>): number | null {
  if (records.length === 0) return null;
  let newest = -Infinity;
  for (const r of records) if (r.tsMs > newest) newest = r.tsMs;
  return newest - DAY_MS;
}

/**
 * Records at or after `sinceMs`, in file order, capped at `limit` by
 * keeping the newest entries (the tail of the window).
 */
export function selectWindow(
  records: ReadonlyArray<ReplayRecord>,
  sinceMs: number,
  limit: number,
): ReplayRecord[] {
  if (limit <= 0) return [];
  const within = records.filter((r) => r.tsMs >= sinceMs);
  return within.slice(Math.max(0, within.length - limit));
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Millisecond offsets from run start for each record (in window order).
 * Inter-arrival gaps are divided by `speed`; speed 0 is back-to-back.
 */
export function buildSchedule(tsMsList: ReadonlyArray<number>, speed: number): number[] {
  if (speed < 0) throw new RangeError(`speed must be >= 0, got ${speed}`);
  if (tsMsList.length === 0) return [];
  const first = tsMsList[0]!;
  if (speed === 0) return tsMsList.map(() => 0);
  return tsMsList.map((ts) => (ts - first) / speed);
}

// ---------------------------------------------------------------------------
// Query and URL (mirrors what the live hook puts on the wire)
// ---------------------------------------------------------------------------

export interface ReplayQueryResult {
  readonly query: string | null;
  /** True when the query was rebuilt from the 200-char preview (pre-T1775b line), not the logged wire query. */
  readonly approximate: boolean;
}

/**
 * The query to replay: the logged recallQuery when present (the hook's real
 * input), otherwise the hook's own composition over the preview. A
 * recallQuery the hook flagged as cut at the log budget replays the real
 * query but approximate: a preview of the remainder is unknown. Both then
 * pass through the extraction recallOverHttp applies before the GET; null
 * means the hook would send nothing for this prompt.
 */
export function replayQuery(
  record: ReplayRecord,
  env: NodeJS.ProcessEnv = process.env,
): ReplayQueryResult {
  if (record.recallQuery !== undefined) {
    return { query: extractRecallQuery(record.recallQuery), approximate: record.recallQueryTruncated === true };
  }
  const input: { prompt: string; conversationId: string } = { prompt: record.promptPreview, conversationId: record.conversationId };
  return { query: extractRecallQuery(buildRecallQuery(input, env)), approximate: true };
}

/** The hook's GET, against a configurable base URL. */
export function recallUrl(baseUrl: string, query: string, conversationId: string | undefined): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return (
    `${base}/api/recall` +
    `?q=${encodeURIComponent(query)}&mode=keyword&limit=${RECALL_LIMIT}&withFacts=true&withExemplars=true&withConcepts=true` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : "")
  );
}

// ---------------------------------------------------------------------------
// Measurement report
// ---------------------------------------------------------------------------

export type Outcome = "ok" | "timeout" | "unreachable" | "http-error";

export interface MeasuredRequest {
  readonly outcome: Outcome;
  readonly ms: number;
}

/** Pre-registered recall SLO targets (T1770). */
export const LOAD_TARGETS = {
  timeoutRate: 0.02,
  failureRate: 0.02,
  recallP95Ms: 1000,
} as const;

export interface LoadReport {
  /** Requests actually sent (skipped prompts never hit the wire). */
  readonly requests: number;
  /** Prompts for which the hook itself would issue no request. */
  readonly skipped: number;
  /** Queries rebuilt from the 200-char preview because the line predates recallQuery logging. */
  readonly approximate: number;
  /** Nothing was measured — no selected record produced a request. Not a pass. */
  readonly noData: boolean;
  readonly counts: Readonly<Record<Outcome, number>>;
  /**
   * Timeouts over sent requests — the literal definition the daemon's
   * /api/health/slo uses, so replay and live numbers compare directly.
   */
  readonly timeoutRate: number;
  /**
   * Every request that did not return an ok recall (timeout, unreachable or
   * http-error) over sent requests — the replay's own availability budget.
   * A daemon that refuses or errors the load fails here even though it
   * never times out, which is what the timeouts-only timeoutRate cannot see.
   */
  readonly failureRate: number;
  /** Latency stats over ok requests only; null fields when none succeeded. */
  readonly latencyMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly max: number | null;
  };
  readonly breaches: ReadonlyArray<string>;
}

/** Nearest-rank percentile (ceil(q*n)); identical to the daemon's p95. */
export function percentile(samples: ReadonlyArray<number>, q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[idx]!;
}

export function buildReport(
  measured: ReadonlyArray<MeasuredRequest>,
  meta: { readonly skipped?: number; readonly approximate?: number } = {},
  targets: {
    readonly timeoutRate: number;
    readonly failureRate: number;
    readonly recallP95Ms: number;
  } = LOAD_TARGETS,
): LoadReport {
  const counts: Record<Outcome, number> = { ok: 0, timeout: 0, unreachable: 0, "http-error": 0 };
  for (const m of measured) counts[m.outcome]++;
  const requests = measured.length;
  const timeoutRate = requests === 0 ? 0 : counts.timeout / requests;
  const failureRate = requests === 0 ? 0 : (requests - counts.ok) / requests;

  const okLatencies = measured.filter((m) => m.outcome === "ok").map((m) => m.ms);
  const p50 = percentile(okLatencies, 0.5);
  const p95 = percentile(okLatencies, 0.95);
  const max = okLatencies.length === 0 ? null : Math.max(...okLatencies);

  const breaches: string[] = [];
  if (timeoutRate > targets.timeoutRate) breaches.push("timeoutRate");
  if (failureRate > targets.failureRate) breaches.push("failureRate");
  if (p95 !== null && p95 > targets.recallP95Ms) breaches.push("recallP95Ms");

  return {
    requests,
    skipped: meta.skipped ?? 0,
    approximate: meta.approximate ?? 0,
    noData: requests === 0,
    counts,
    timeoutRate,
    failureRate,
    latencyMs: { p50, p95, max },
    breaches,
  };
}
