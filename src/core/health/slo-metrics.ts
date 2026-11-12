/**
 * SLO metrics store (T1771): rolling 24h/7d counters behind GET
 * /api/health/slo.
 *
 * Sources, in order of how they arrive:
 *   • Prompt-recall outcomes — the hook processes (not the daemon) append
 *     records to hook-log.jsonl, so the daemon tail-reads the file by byte
 *     offset instead of watching a writer it does not own. Records carrying a
 *     known `recallOutcome` (the ones without `kind`: prompt-recall and
 *     session-start fires) count toward the timeout-rate SLO; a numeric
 *     `latencyMs` on a record becomes a latency sample (p95). No latency
 *     field exists in the hook build today, so real deployments report
 *     `p95Ms: null` and the route omits the recallP95Ms breach — the shape is
 *     fixed now so the hook can add the field without an endpoint change.
 *   • Loop stalls — `recordStall(ms)` is fed by the lag monitor's
 *     `onStallObserved` (blocks over SLO_TARGETS.maxStallMs).
 *   • Ingest/classify lag — the last /api/health/ingest report the daemon
 *     sampled (`recordIngestReport`), reduced to minute gauges. A gauge, not
 *     a counter: a sample older than the queried window reads as missing.
 *
 * Persistence: one small JSON file (slo-metrics.json) in the tenant state
 * dir, written atomically by `persist()` on the daemon's refresh timer —
 * same shape as the other small state files (update-check.json). Everything
 * is best-effort: a missing/corrupt file starts the counters empty, a failed
 * poll never throws into the timer.
 */

import {
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { hookLogPath } from "@core/recall/hook-recall-log.js";
import type { IngestLagReport } from "./ingest-lag.js";

export type SloWindow = "24h" | "7d";

export const SLO_WINDOW_MS: Record<SloWindow, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

/** Targets GET /api/health/slo reports against. Fixed for now; the response
 *  echoes them so a dashboard never hardcodes a copy. */
export const SLO_TARGETS = {
  /** Fraction of hook-lane recall outcomes that timed out. */
  timeoutRate: 0.02,
  /** Prompt-recall p95 latency; not evaluated when no latency samples exist. */
  recallP95Ms: 1000,
  /** Longest tolerated synchronous event-loop block. */
  maxStallMs: 250,
  /** Oldest pending transcript, in minutes. */
  lagMinutes: 15,
} as const;

export type SloTargetName = keyof typeof SLO_TARGETS;

export const RECALL_OUTCOMES = ["ok", "timeout", "unreachable", "http-error", "skipped"] as const;
export type RecallOutcome = (typeof RECALL_OUTCOMES)[number];

function isRecallOutcome(v: unknown): v is RecallOutcome {
  return typeof v === "string" && (RECALL_OUTCOMES as readonly string[]).includes(v);
}

export interface SloRecallEvent {
  readonly ts: number;
  readonly outcome: RecallOutcome;
  readonly latencyMs?: number;
}

export interface SloStallEvent {
  readonly ts: number;
  readonly ms: number;
}

export interface SloIngestSample {
  readonly sampledAt: number;
  /** Oldest pending transcript at sample time; null when nothing was pending. */
  readonly lagMinutes: number | null;
  /** Minutes since the classifier last progressed; null when never. */
  readonly classifyLagMinutes: number | null;
  readonly lagging: boolean;
  readonly timeouts1h: number;
  readonly summary: string;
}

export interface SloState {
  readonly savedAt: number;
  readonly recall: readonly SloRecallEvent[];
  readonly stalls: readonly SloStallEvent[];
  readonly ingest: SloIngestSample | null;
}

const MAX_WINDOW_MS = SLO_WINDOW_MS["7d"];
const EMPTY_STATE: SloState = { savedAt: 0, recall: [], stalls: [], ingest: null };

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Drop events past the largest supported window (clock-skewed future ts kept
 *  — they belong to a window query, not to pruning). */
export function pruneSloState(state: SloState, nowMs: number): SloState {
  const cutoff = nowMs - MAX_WINDOW_MS;
  return {
    savedAt: state.savedAt,
    recall: state.recall.filter((e) => e.ts >= cutoff),
    stalls: state.stalls.filter((e) => e.ts >= cutoff),
    ingest: state.ingest,
  };
}

// ── computation (pure) ────────────────────────────────────────────────

export interface SloActual {
  readonly outcomes: {
    readonly total: number;
    readonly byOutcome: Readonly<Record<RecallOutcome, number>>;
    /** timeouts/total, null when the window holds no outcomes. */
    readonly timeoutRate: number | null;
  };
  readonly recallLatency: {
    readonly samples: number;
    /** Nearest-rank p95; null when no latency sample exists (older hook builds). */
    readonly p95Ms: number | null;
  };
  readonly stalls: {
    readonly count: number;
    readonly maxMs: number | null;
  };
  readonly ingest: {
    readonly sampledAt: string;
    readonly lagMinutes: number | null;
    readonly classifyLagMinutes: number | null;
    readonly lagging: boolean;
    readonly timeouts1h: number;
    readonly summary: string;
  } | null;
}

/** Nearest-rank p95 (ceil(0.95*n)); null for an empty sample set. */
export function p95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}

export function computeSloActual(state: SloState, window: SloWindow, nowMs: number): SloActual {
  const from = nowMs - SLO_WINDOW_MS[window];
  const recall = state.recall.filter((e) => e.ts >= from && e.ts <= nowMs);
  const byOutcome: Record<RecallOutcome, number> = {
    ok: 0,
    timeout: 0,
    unreachable: 0,
    "http-error": 0,
    skipped: 0,
  };
  const latencies: number[] = [];
  for (const e of recall) {
    byOutcome[e.outcome] += 1;
    if (typeof e.latencyMs === "number" && Number.isFinite(e.latencyMs) && e.latencyMs >= 0) {
      latencies.push(e.latencyMs);
    }
  }
  const stalls = state.stalls.filter((e) => e.ts >= from && e.ts <= nowMs);
  // A gauge is only meaningful if it was sampled inside the window; a 7-day-
  // old ingest sample says nothing about "now" and must not mask a lag breach
  // (or invent one) for a window it never covered.
  const ingest = state.ingest && state.ingest.sampledAt >= from && state.ingest.sampledAt <= nowMs
    ? {
        sampledAt: new Date(state.ingest.sampledAt).toISOString(),
        lagMinutes: state.ingest.lagMinutes,
        classifyLagMinutes: state.ingest.classifyLagMinutes,
        lagging: state.ingest.lagging,
        timeouts1h: state.ingest.timeouts1h,
        summary: state.ingest.summary,
      }
    : null;
  return {
    outcomes: {
      total: recall.length,
      byOutcome,
      timeoutRate: recall.length === 0 ? null : round1((byOutcome.timeout / recall.length) * 10000) / 10000,
    },
    recallLatency: { samples: latencies.length, p95Ms: p95(latencies) },
    stalls: {
      count: stalls.length,
      maxMs: stalls.length === 0 ? null : Math.max(...stalls.map((e) => e.ms)),
    },
    ingest,
  };
}

/** Names of the targets the actuals violate. A null/absent measurement is
 *  never a breach — absence is reported by the null in `actual`. */
export function sloBreaches(
  actual: SloActual,
  targets: typeof SLO_TARGETS = SLO_TARGETS,
): SloTargetName[] {
  const breaches: SloTargetName[] = [];
  const rate = actual.outcomes.timeoutRate;
  if (rate !== null && rate > targets.timeoutRate) breaches.push("timeoutRate");
  const p = actual.recallLatency.p95Ms;
  if (p !== null && p > targets.recallP95Ms) breaches.push("recallP95Ms");
  const stall = actual.stalls.maxMs;
  if (stall !== null && stall > targets.maxStallMs) breaches.push("maxStallMs");
  const lag = actual.ingest?.lagMinutes ?? null;
  if (lag !== null && lag > targets.lagMinutes) breaches.push("lagMinutes");
  return breaches;
}

export interface SloResponse {
  readonly window: SloWindow;
  readonly targets: typeof SLO_TARGETS;
  readonly actual: SloActual;
  readonly breaches: readonly SloTargetName[];
}

export function buildSloResponse(
  state: SloState,
  window: SloWindow,
  nowMs: number,
  targets: typeof SLO_TARGETS = SLO_TARGETS,
): SloResponse {
  const actual = computeSloActual(state, window, nowMs);
  return { window, targets, actual, breaches: sloBreaches(actual, targets) };
}

/** Reduce an /api/health/ingest report to the minute gauges the SLO reads. */
export function computeIngestSample(report: IngestLagReport, nowMs: number): SloIngestSample {
  let oldest: number | null = null;
  for (const lag of Object.values(report.adapters)) {
    if (lag.oldest_pending_at === null) continue;
    const ms = Date.parse(lag.oldest_pending_at);
    if (Number.isFinite(ms) && (oldest === null || ms < oldest)) oldest = ms;
  }
  const progressAt = report.last_progress_at !== null ? Date.parse(report.last_progress_at)
    : report.last_success_at !== null ? Date.parse(report.last_success_at)
    : null;
  return {
    sampledAt: nowMs,
    lagMinutes: oldest === null ? null : round1((nowMs - oldest) / 60_000),
    classifyLagMinutes: progressAt === null || !Number.isFinite(progressAt)
      ? null
      : round1((nowMs - progressAt) / 60_000),
    lagging: report.lagging,
    timeouts1h: report.timeouts_1h,
    summary: report.summary,
  };
}

// ── persistence (epoch in memory, ISO in the file) ───────────────────

interface PersistedEvent { ts: string; outcome?: string; latencyMs?: number; ms?: number }
interface PersistedState {
  schemaVersion: 1;
  savedAt: string;
  recall: PersistedEvent[];
  stalls: PersistedEvent[];
  ingest: {
    sampledAt: string;
    lagMinutes: number | null;
    classifyLagMinutes: number | null;
    lagging: boolean;
    timeouts1h: number;
    summary: string;
  } | null;
}

function serialize(state: SloState): string {
  const out: PersistedState = {
    schemaVersion: 1,
    savedAt: new Date(state.savedAt).toISOString(),
    recall: state.recall.map((e) => ({
      ts: new Date(e.ts).toISOString(),
      outcome: e.outcome,
      ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
    })),
    stalls: state.stalls.map((e) => ({ ts: new Date(e.ts).toISOString(), ms: e.ms })),
    ingest: state.ingest && {
      sampledAt: new Date(state.ingest.sampledAt).toISOString(),
      lagMinutes: state.ingest.lagMinutes,
      classifyLagMinutes: state.ingest.classifyLagMinutes,
      lagging: state.ingest.lagging,
      timeouts1h: state.ingest.timeouts1h,
      summary: state.ingest.summary,
    },
  };
  return JSON.stringify(out);
}

function deserialize(raw: string): SloState | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const p = obj as Partial<PersistedState>;
  if (p.schemaVersion !== 1 || !Array.isArray(p.recall) || !Array.isArray(p.stalls)) return null;
  const recall: SloRecallEvent[] = [];
  for (const e of p.recall) {
    const ts = Date.parse(e?.ts ?? "");
    if (!Number.isFinite(ts) || !isRecallOutcome(e.outcome)) continue;
    recall.push({
      ts,
      outcome: e.outcome,
      ...(typeof e.latencyMs === "number" && Number.isFinite(e.latencyMs) ? { latencyMs: e.latencyMs } : {}),
    });
  }
  const stalls: SloStallEvent[] = [];
  for (const e of p.stalls) {
    const ts = Date.parse(e?.ts ?? "");
    if (!Number.isFinite(ts) || typeof e.ms !== "number" || !Number.isFinite(e.ms)) continue;
    stalls.push({ ts, ms: e.ms });
  }
  let ingest: SloIngestSample | null = null;
  if (p.ingest && typeof p.ingest === "object" && Number.isFinite(Date.parse(p.ingest.sampledAt))) {
    ingest = {
      sampledAt: Date.parse(p.ingest.sampledAt),
      lagMinutes: typeof p.ingest.lagMinutes === "number" ? p.ingest.lagMinutes : null,
      classifyLagMinutes: typeof p.ingest.classifyLagMinutes === "number" ? p.ingest.classifyLagMinutes : null,
      lagging: p.ingest.lagging === true,
      timeouts1h: typeof p.ingest.timeouts1h === "number" ? p.ingest.timeouts1h : 0,
      summary: typeof p.ingest.summary === "string" ? p.ingest.summary : "",
    };
  }
  const savedAt = typeof p.savedAt === "string" ? Date.parse(p.savedAt) : Number.NaN;
  return { savedAt: Number.isFinite(savedAt) ? savedAt : 0, recall, stalls, ingest };
}

// ── hook-log tail reader ──────────────────────────────────────────────

/** Parse one hook-log JSONL line into a recall event, or null to ignore it.
 *  The records that carry `recallOutcome` are exactly the kind-less recall
 *  fires (prompt-recall, session-start); kind-carrying lines (stop,
 *  session-end, pre-compact) and malformed lines are skipped. */
export function parseHookRecord(line: string): SloRecallEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || obj["kind"] !== undefined) return null;
  if (!isRecallOutcome(obj["recallOutcome"])) return null;
  const ts = typeof obj["ts"] === "string" ? Date.parse(obj["ts"]) : Number.NaN;
  if (!Number.isFinite(ts)) return null;
  const latency = obj["latencyMs"];
  return {
    ts,
    outcome: obj["recallOutcome"],
    ...(typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? { latencyMs: latency } : {}),
  };
}

// ── store ─────────────────────────────────────────────────────────────

export interface IngestLagSampler {
  get(): Promise<IngestLagReport>;
}

export interface SloMetricsDeps {
  readonly now?: () => number;
  /** hook-log.jsonl to tail. Defaults to the same resolution the readers use
   *  ($NLM_HOOK_LOG for the default team, tenant path otherwise). */
  readonly hookLogPath?: string;
  /** State file. Default $NLM_SLO_STATE or <state root>/slo-metrics.json. */
  readonly statePath?: string;
}

export interface SloMetricsStore {
  /** Load the persisted file (missing/corrupt starts empty). Idempotent. */
  load(): void;
  /** Tail the hook log from the last consumed byte offset; returns the number
   *  of new outcome records consumed. Never throws. */
  pollHookLog(): number;
  /** One observed event-loop stall in ms (from the lag monitor observer). */
  recordStall(ms: number, ts?: number): void;
  /** Stash the latest /api/health/ingest report as minute gauges. */
  recordIngestReport(report: IngestLagReport): void;
  snapshot(): SloState;
  /** Atomic write of the pruned state. Best-effort, never throws. */
  persist(): void;
  /** poll + optional ingest sample + persist — what the daemon's timer calls. */
  refresh(ingestLag?: IngestLagSampler): Promise<void>;
}

export function createSloMetricsStore(deps: SloMetricsDeps = {}): SloMetricsStore {
  const now = deps.now ?? Date.now;
  const logPath = () => deps.hookLogPath ?? hookLogPath(DEFAULT_TEAM_ID);
  const statePath = () =>
    deps.statePath ?? process.env["NLM_SLO_STATE"] ?? tenantStatePath(DEFAULT_TEAM_ID, "slo-metrics.json");

  let state: SloState = { ...EMPTY_STATE };
  let offset = 0;

  return {
    load(): void {
      try {
        const parsed = deserialize(readFileSyncSafe(statePath()));
        if (parsed) state = pruneSloState(parsed, now());
      } catch {
        // missing/unreadable starts empty — telemetry must never break the daemon
      }
    },

    pollHookLog(): number {
      let size: number;
      try {
        size = statSync(logPath()).size;
      } catch {
        return 0;
      }
      if (size < offset) {
        // truncated or rotated: re-read from the start
        offset = 0;
      }
      if (size === offset) return 0;
      let chunk: string;
      const fd = openSync(logPath(), "r");
      try {
        const buf = Buffer.alloc(size - offset);
        const read = readSync(fd, buf, 0, buf.length, offset);
        const text = buf.toString("utf8", 0, read);
        // A trailing line without a newline may be mid-append in another
        // process. The byte offset stays on it and the next poll re-reads it
        // once the writer completes the line — no carry buffer needed, since
        // offset only advances over newline-terminated bytes (`\n` is never
        // part of a multi-byte UTF-8 sequence, so the split is byte-safe).
        const lastNl = text.lastIndexOf("\n");
        chunk = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
        offset += Buffer.byteLength(chunk, "utf8");
      } finally {
        closeSync(fd);
      }
      return consumeLines(chunk);
    },

    recordStall(ms: number, ts?: number): void {
      if (!Number.isFinite(ms) || ms < 0) return;
      state = { ...state, stalls: [...state.stalls, { ts: ts ?? now(), ms }] };
    },

    recordIngestReport(report: IngestLagReport): void {
      state = { ...state, ingest: computeIngestSample(report, now()) };
    },

    snapshot(): SloState {
      return state;
    },

    persist(): void {
      const snapshot = pruneSloState({ ...state, savedAt: now() }, now());
      state = snapshot;
      const path = statePath();
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = join(dirname(path), `.slo-metrics.${process.pid}.tmp`);
        writeFileSync(tmp, serialize(snapshot), "utf8");
        renameSync(tmp, path);
      } catch {
        // same contract as appendHookLog: telemetry writes never break callers
      }
    },

    async refresh(ingestLag?: IngestLagSampler): Promise<void> {
      this.pollHookLog();
      if (ingestLag) {
        try {
          this.recordIngestReport(await ingestLag.get());
        } catch {
          // stale sample stays; next tick retries
        }
      }
      this.persist();
    },
  };

  function consumeLines(chunk: string): number {
    if (!chunk) return 0;
    const fresh: SloRecallEvent[] = [];
    const horizon = now();
    for (const line of chunk.split("\n")) {
      const ev = parseHookRecord(line);
      if (!ev) continue;
      // Records older than the biggest window can never be counted.
      if (ev.ts < horizon - MAX_WINDOW_MS) continue;
      fresh.push(ev);
    }
    if (fresh.length > 0) state = { ...state, recall: [...state.recall, ...fresh] };
    return fresh.length;
  }
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
