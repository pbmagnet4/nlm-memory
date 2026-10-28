/**
 * Ingest-lag health: how many source files the adapters discover that the
 * scheduler has not yet ingested, how old the oldest of them is, and whether
 * the classifier is making progress. Stat-only (no transcript reads), bounded
 * to recently modified files, cached for 60s.
 *
 * "Pending" mirrors scan-once.ts: a discovered file the scheduler would parse
 * on its next tick — no adapter_state row, or a size that differs from the
 * recorded one — and that is past the idle gate. Files parked at
 * MAX_CLASSIFY_FAILURES (same size as when they failed) are counted apart.
 */

import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Pool } from "pg";
import type { SourceStat, TranscriptAdapter } from "@ports/transcript-adapter.js";
import { MAX_CLASSIFY_FAILURES } from "@core/scheduler/scan-once.js";
import { PgSessionStore } from "@core/storage/pg-session-store.js";
import type { SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import { classifyOutcomesSnapshot, OUTCOME_WINDOW_MS } from "./classify-outcomes.js";

/** Only files modified in this window are stat'ed, which keeps the pass cheap. */
export const LOOKBACK_MS = 14 * 86_400_000;
const CACHE_TTL_MS = 60_000;
const DEFAULT_ALERT_HOURS = 6;

export interface AdapterLag {
  readonly pending: number;
  readonly parked: number;
  readonly oldest_pending_at: string | null;
}

export interface IngestLagReport {
  readonly adapters: Readonly<Record<string, AdapterLag>>;
  readonly last_success_at: string | null;
  readonly timeouts_1h: number;
  readonly errors_1h: number;
  readonly lagging: boolean;
  readonly summary: string;
}

export interface AdapterStateEntry {
  readonly fileSize: number | null;
  readonly failureCount: number;
}

export type AdapterStateReader = (adapterName: string) => Promise<ReadonlyMap<string, AdapterStateEntry>>;

export interface IngestLagDeps {
  /** Enabled, detected adapters; called per computation so source changes apply. */
  readonly listAdapters: () => Promise<ReadonlyArray<TranscriptAdapter>>;
  readonly readState: AdapterStateReader;
  readonly idleMinutes: number;
  readonly thresholdHours: number;
}

/** NLM_INGEST_LAG_ALERT_HOURS, default 6; read once at boot. */
export function ingestLagThresholdHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env["NLM_INGEST_LAG_ALERT_HOURS"]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_HOURS;
}

/** Reads adapter_state from whichever backend the store runs on, as the scheduler does. */
export function adapterStateReader(store: SqliteSessionStore | PgSessionStore): AdapterStateReader {
  if (store instanceof PgSessionStore) return pgStateReader(store.pool);
  return sqliteStateReader(store.rawDb());
}

function sqliteStateReader(db: Database.Database): AdapterStateReader {
  return async (adapterName) => {
    const rows = db
      .prepare<[string], { source_path: string; file_size: number | null; failure_count: number }>(
        "SELECT source_path, file_size, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ?",
      )
      .all(adapterName);
    return new Map(rows.map((r) => [r.source_path, { fileSize: r.file_size, failureCount: r.failure_count }]));
  };
}

function pgStateReader(pool: Pool): AdapterStateReader {
  return async (adapterName) => {
    const res = await pool.query<{ source_path: string; file_size: string | null; failure_count: number }>(
      "SELECT source_path, file_size, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = $1",
      [adapterName],
    );
    // pg returns BIGINT as a string.
    return new Map(
      res.rows.map((r) => [
        r.source_path,
        { fileSize: r.file_size === null ? null : Number(r.file_size), failureCount: r.failure_count },
      ]),
    );
  };
}

function statSource(adapter: TranscriptAdapter, source: string): SourceStat | null {
  if (adapter.stat) return adapter.stat(source);
  try {
    return statSync(source);
  } catch {
    return null;
  }
}

async function adapterLag(
  adapter: TranscriptAdapter,
  deps: IngestLagDeps,
  now: number,
): Promise<AdapterLag & { oldestMs: number | null }> {
  const state = await deps.readState(adapter.name);
  const idleMs = deps.idleMinutes * 60_000;
  let pending = 0;
  let parked = 0;
  let oldestMs: number | null = null;
  for (const path of await adapter.discover({ since: new Date(now - LOOKBACK_MS) })) {
    const st = statSource(adapter, path);
    if (!st || now - st.mtimeMs < idleMs) continue;
    const prior = state.get(path);
    if (prior && (prior.fileSize ?? 0) === st.size) {
      if (prior.failureCount >= MAX_CLASSIFY_FAILURES) parked += 1;
      continue;
    }
    pending += 1;
    if (oldestMs === null || st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
  }
  return {
    pending,
    parked,
    oldest_pending_at: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    oldestMs,
  };
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export async function computeIngestLag(deps: IngestLagDeps, now: number = Date.now()): Promise<IngestLagReport> {
  const adapters: Record<string, AdapterLag> = {};
  let totalPending = 0;
  let oldestMs: number | null = null;
  for (const adapter of await deps.listAdapters()) {
    const { oldestMs: adapterOldest, ...lag } = await adapterLag(adapter, deps, now);
    adapters[adapter.name] = lag;
    totalPending += lag.pending;
    if (adapterOldest !== null && (oldestMs === null || adapterOldest < oldestMs)) oldestMs = adapterOldest;
  }

  const outcomes = classifyOutcomesSnapshot(now);
  const oldestAgeMs = oldestMs === null ? null : now - oldestMs;
  const stalled = now - (outcomes.lastSuccessAt ?? outcomes.startedAt) > OUTCOME_WINDOW_MS;
  const lagging =
    (oldestAgeMs !== null && oldestAgeMs > deps.thresholdHours * 3_600_000) || (totalPending > 0 && stalled);
  const summary =
    `${totalPending} pending, ` +
    (oldestAgeMs === null ? "" : `oldest ${formatAge(oldestAgeMs)}, `) +
    `${outcomes.successes1h} ok/1h`;

  return {
    adapters,
    last_success_at: outcomes.lastSuccessAt === null ? null : new Date(outcomes.lastSuccessAt).toISOString(),
    timeouts_1h: outcomes.timeouts1h,
    errors_1h: outcomes.errors1h,
    lagging,
    summary,
  };
}

export interface IngestLagMonitor {
  get(): Promise<IngestLagReport>;
}

/** Caches the computed report for 60s in-process (concurrent callers share one pass). */
export function createIngestLagMonitor(deps: IngestLagDeps, clock: () => number = Date.now): IngestLagMonitor {
  let cached: { at: number; report: Promise<IngestLagReport> } | null = null;
  return {
    get() {
      const now = clock();
      if (cached && now - cached.at < CACHE_TTL_MS) return cached.report;
      const report = computeIngestLag(deps, now);
      cached = { at: now, report };
      report.catch(() => {
        if (cached?.report === report) cached = null;
      });
      return report;
    },
  };
}
