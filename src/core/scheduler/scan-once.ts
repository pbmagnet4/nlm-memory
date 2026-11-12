/**
 * scanOnce — mtime-gated incremental discovery shared by every adapter.
 *
 * The Python codebase bundled this logic into each adapter (`scan_once` +
 * `record_classified` methods). In the TS port the adapter stays a pure
 * parser (TranscriptAdapter port); the mtime check and adapter_state
 * upsert live here, generic over the adapter. Same behavior, less
 * duplication across claude-code / hermes / pi.
 *
 * Contract (per file under adapter.discover()):
 *   - If `now - mtime < idleMinutes * 60s` → still active, skip
 *   - Lookup adapter_state by (adapterName, sourcePath):
 *       no row + file idle                       → NEW: parse + return (chunk, supersedes=null)
 *       row exists, size match, failures < ceil  → UNCHANGED: skip
 *       row exists, size match, failures >= ceil → FAILED_CEILING: skip (log once per session)
 *       row exists, file grew                    → RESUMED: parse + return, reset failure_count
 *   - After successful classify+insert downstream, call `recordClassified`
 *     to upsert adapter_state with the new size + session_id.
 *   - On classify/storage failure, call `recordFailed` to increment failure_count.
 *     When failure_count reaches MAX_CLASSIFY_FAILURES and the file hasn't grown,
 *     the file is permanently skipped until new content arrives.
 */

import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Pool } from "pg";
import type {
  SessionChunk,
  SourceStat,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { timeSyncSlice } from "@core/scheduler/loop-monitor.js";
import { yieldToEventLoop } from "@core/util/yield-loop.js";
import { recordIngestProgress } from "@core/health/classify-outcomes.js";

export interface ScanResult {
  readonly chunk: SessionChunk;
  readonly supersedes: string | null;
  readonly fileSize: number;
  /** True when the source was classified before and has changed size since (not a first sighting). */
  readonly resumed: boolean;
}

export const MAX_CLASSIFY_FAILURES = 3;

/**
 * parseSession returns null only for a source with nothing to classify; an I/O
 * error throws. A throw leaves the source unrecorded so the next tick retries
 * it, and must not stop the scan of the other sources.
 */
async function parseOrLog(
  adapter: TranscriptAdapter,
  source: string,
  log: (msg: string) => void,
): Promise<{ chunk: SessionChunk | null } | null> {
  try {
    return { chunk: await adapter.parseSession(source) };
  } catch (e) {
    log(`[scan] ${adapter.name} could not read ${source}, will retry: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Adapter-provided stat for non-file sources, else the file's; null when unreadable. */
function statSource(adapter: TranscriptAdapter, source: string): SourceStat | null {
  if (adapter.stat) return adapter.stat(source);
  try {
    return statSync(source);
  } catch {
    return null;
  }
}

/**
 * Stat failures from an adapter (a busy DB) skip that source for this tick; the
 * scan continues. Collected so the tick logs once per adapter, not per source.
 */
class StatFailures {
  private count = 0;
  private first = "";

  stat(adapter: TranscriptAdapter, source: string): SourceStat | null {
    try {
      return statSource(adapter, source);
    } catch (e) {
      if (this.count++ === 0) this.first = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  report(adapter: TranscriptAdapter, log: (msg: string) => void): void {
    if (this.count > 0) {
      log(`[scan] ${adapter.name} could not stat ${this.count} source(s), skipped this tick: ${this.first}`);
    }
  }
}

interface AdapterStateRow {
  source_path: string;
  file_size: number | null;
  session_id: string | null;
  failure_count: number;
}

/** Sources examined between event-loop yields (T1757). Everything between two
 *  of these positions in the scan loop is synchronous for an unchanged file —
 *  `statSync`, a Map lookup, sometimes one `UPDATE` — so the loop over a whole
 *  adapter's discovery list was one slice: `scheduler-tick took 166164ms (sync
 *  slice 5750.8ms)` on the live corpus. 100 is a few milliseconds of stat even on
 *  a loaded volume, and the yield costs nothing next to the `parseSession` and
 *  classify calls the loop already awaits for the files that are new. */
export const SCAN_BATCH_SOURCES = 100;

/** How the scan loop hands the loop back (T1757). All optional; production uses
 *  the defaults, tests count the hand-offs through `yieldFn`. */
export interface ScanPacing {
  readonly yieldEverySources?: number;
  readonly yieldFn?: () => Promise<void>;
  /** Loop-monitor sink/threshold for `[loop] sync scan:..` lines. */
  readonly loopLogger?: (msg: string) => void;
  readonly loopThresholdMs?: number;
}

const DEFAULT_SCAN_PACING: ScanPacing = {};

function scanTiming(pacing: ScanPacing) {
  return {
    ...(pacing.loopLogger ? { logger: pacing.loopLogger } : {}),
    ...(pacing.loopThresholdMs !== undefined ? { thresholdMs: pacing.loopThresholdMs } : {}),
  };
}

/** Yield position for scan iteration `i`: `false` for the first `batch` sources
 *  and after the last one is handled implicitly (the loop ends). Checked at the
 * *top* of each iteration rather than at its end so no `continue` in the body can
 *  skip a hand-off. */
function shouldYield(i: number, batch: number): boolean {
  return i > 0 && i % batch === 0;
}

export async function scanOnce(
  adapter: TranscriptAdapter,
  idleMinutes: number,
  db: Database.Database,
  now: number = Date.now(),
  log: (msg: string) => void = console.error,
  pacing: ScanPacing = DEFAULT_SCAN_PACING,
): Promise<ReadonlyArray<ScanResult>> {
  const idleMs = idleMinutes * 60 * 1000;
  const yieldFn = pacing.yieldFn ?? yieldToEventLoop;
  const batch = Math.max(1, pacing.yieldEverySources ?? SCAN_BATCH_SOURCES);
  const stateRows = timeSyncSlice(
    "scan",
    `adapter_state:${adapter.name}`,
    // One statement for every row of this adapter (one per source path ever
    // ingested), so it gets its own slice line: bounded by tracked files today,
    // unbounded in general, and it runs at the top of every tick per adapter.
    () =>
      db
        .prepare<[string], AdapterStateRow>(
          "SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = ?",
        )
        .all(adapter.name),
    scanTiming(pacing),
  );
  const byPath = new Map<string, AdapterStateRow>(stateRows.map((r) => [r.source_path, r]));

  const out: ScanResult[] = [];
  const files = await adapter.discover();
  const statFailures = new StatFailures();

  for (let i = 0; i < files.length; i++) {
    if (shouldYield(i, batch)) await yieldFn();
    const path = files[i]!;
    const st = statFailures.stat(adapter, path);
    if (!st) continue;
    const age = now - st.mtimeMs;
    if (age < idleMs) continue;

    const prior = byPath.get(path);
    if (prior) {
      const sizeUnchanged = (prior.file_size ?? 0) === st.size;
      if (sizeUnchanged) {
        // File hasn't grown — skip whether clean or failed. Failures only
        // retry when the transcript file receives new content.
        continue;
      }
      // File grew: reset failure_count so resume gets a clean slate.
      if (prior.failure_count >= MAX_CLASSIFY_FAILURES) {
        db.prepare(
          "UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = ? AND source_path = ?",
        ).run(adapter.name, path);
      }
    }

    const parsed = await parseOrLog(adapter, path, log);
    if (!parsed) continue;
    const chunk = parsed.chunk;
    if (!chunk) {
      recordSkipped(db, adapter.name, path, st.size);
      recordIngestProgress();
      continue;
    }
    const supersedes =
      prior?.session_id && prior.session_id !== chunk.id ? prior.session_id : null;
    out.push({ chunk, supersedes, fileSize: st.size, resumed: prior !== undefined });
  }
  statFailures.report(adapter, log);
  return out;
}

export function recordClassified(
  db: Database.Database,
  adapterName: string,
  sourcePath: string,
  sessionId: string,
  fileSize: number,
): void {
  db.prepare(
    `INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size = excluded.file_size,
       session_id = excluded.session_id,
       failure_count = 0,
       last_processed_at = excluded.last_processed_at`,
  ).run(adapterName, sourcePath, fileSize, fileSize, sessionId);
}

export function recordFailed(
  db: Database.Database,
  adapterName: string,
  sourcePath: string,
  fileSize: number,
): void {
  db.prepare(
    `INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, NULL, 1, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       file_size = excluded.file_size,
       failure_count = failure_count + 1,
       last_processed_at = excluded.last_processed_at`,
  ).run(adapterName, sourcePath, fileSize, fileSize);
}

export async function scanOncePg(
  adapter: TranscriptAdapter,
  idleMinutes: number,
  pool: Pool,
  now: number = Date.now(),
  log: (msg: string) => void = console.error,
  pacing: ScanPacing = DEFAULT_SCAN_PACING,
): Promise<ScanResult[]> {
  const idleMs = idleMinutes * 60 * 1000;
  const stateRows = await pool.query<{
    source_path: string;
    file_size: string | null;
    session_id: string | null;
    failure_count: number;
  }>(
    `SELECT source_path, file_size, session_id, COALESCE(failure_count, 0) AS failure_count
     FROM adapter_state WHERE adapter_name = $1`,
    [adapter.name],
  );
  // pg returns BIGINT (file_size) as a string; coerce to number so the
  // unchanged-size check compares against statSync's numeric size.
  const stateMap = new Map(
    stateRows.rows.map((r) => [
      r.source_path,
      {
        fileSize: r.file_size === null ? null : Number(r.file_size),
        sessionId: r.session_id,
        failureCount: r.failure_count,
      },
    ]),
  );

  const paths = await adapter.discover();
  const results: ScanResult[] = [];
  const statFailures = new StatFailures();
  const yieldFn = pacing.yieldFn ?? yieldToEventLoop;
  const batch = Math.max(1, pacing.yieldEverySources ?? SCAN_BATCH_SOURCES);

  for (let i = 0; i < paths.length; i++) {
    if (shouldYield(i, batch)) await yieldFn();
    // Bug 1 fix: mtime gate — skip files still being written
    const sourcePath = paths[i]!;
    const st = statFailures.stat(adapter, sourcePath);
    if (!st) continue;
    if (now - st.mtimeMs < idleMs) continue;

    const state = stateMap.get(sourcePath);

    // Bug 2 fix: skip unchanged files for ALL paths, not just failure-ceiling paths
    if (state?.fileSize !== undefined && state.fileSize !== null) {
      if (st.size === state.fileSize) continue;
    }

    if (state && state.failureCount >= MAX_CLASSIFY_FAILURES) {
      // File has grown (we didn't continue above), reset failure count
      await pool.query(
        "UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = $1 AND source_path = $2",
        [adapter.name, sourcePath],
      );
    }

    const parsed = await parseOrLog(adapter, sourcePath, log);
    if (!parsed) continue;
    const chunk = parsed.chunk;
    if (!chunk) {
      await recordSkippedPg(pool, adapter.name, sourcePath, st.size);
      recordIngestProgress();
      continue;
    }

    const supersedes =
      state?.sessionId && state.sessionId !== chunk.id ? state.sessionId : null;
    results.push({ chunk, supersedes, fileSize: st.size, resumed: state !== undefined });
  }

  statFailures.report(adapter, log);
  return results;
}

export async function recordClassifiedPg(
  pool: Pool,
  adapterName: string,
  sourcePath: string,
  sessionId: string,
  fileSize: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES ($1, $2, 0, $3, $4, 0, NOW())
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       file_size = EXCLUDED.file_size,
       session_id = EXCLUDED.session_id,
       failure_count = 0,
       last_processed_at = NOW()`,
    [adapterName, sourcePath, fileSize, sessionId],
  );
}

/** Marks a source seen at this size without a session (low-confidence or empty): skipped until it grows. */
export function recordSkipped(
  db: Database.Database,
  adapterName: string,
  sourcePath: string,
  fileSize: number,
): void {
  db.prepare(
    `INSERT INTO adapter_state
       (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES (?, ?, ?, ?, NULL, 0, datetime('now'))
     ON CONFLICT(adapter_name, source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size = excluded.file_size,
       failure_count = 0,
       last_processed_at = excluded.last_processed_at`,
  ).run(adapterName, sourcePath, fileSize, fileSize);
}

export async function recordSkippedPg(
  pool: Pool,
  adapterName: string,
  sourcePath: string,
  fileSize: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count, last_processed_at)
     VALUES ($1, $2, 0, $3, NULL, 0, NOW())
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       file_size = EXCLUDED.file_size,
       failure_count = 0,
       last_processed_at = NOW()`,
    [adapterName, sourcePath, fileSize],
  );
}

export async function recordFailedPg(
  pool: Pool,
  adapterName: string,
  sourcePath: string,
  fileSize: number | null,
): Promise<number> {
  const res = await pool.query<{ failure_count: number }>(
    `INSERT INTO adapter_state (adapter_name, source_path, last_offset, failure_count, file_size)
     VALUES ($1, $2, 0, 1, $3)
     ON CONFLICT (adapter_name, source_path) DO UPDATE SET
       failure_count = adapter_state.failure_count + 1,
       file_size = $3,
       last_processed_at = NOW()
     RETURNING failure_count`,
    [adapterName, sourcePath, fileSize],
  );
  return res.rows[0]?.failure_count ?? 1;
}
