/**
 * T1772 Part 1+2: the daemon's scheduled online backup.
 *
 * Complements the operator-run `nlm backup` (VACUUM INTO, daily-by-hand) with
 * an unattended job so the RPO is <= 24h even on a machine nobody babysits:
 * every `NLM_BACKUP_INTERVAL_HOURS` (default 24) the daemon snapshots the
 * canonical store with better-sqlite3's *online backup API* — `db.backup()`
 * copies page-by-page and yields to the event loop between steps, so unlike
 * a synchronous VACUUM the loop stays responsive throughout — to
 * `<dataDir>/backups/canonical-<UTC yyyymmddHHMM>.sqlite`, keeping the
 * newest `NLM_BACKUP_KEEP` (default 7). `NLM_BACKUP=off` disables the job.
 *
 * Guards, in order, before copying:
 *  - fresh-backup skip: a backup newer than the interval makes the run a
 *    no-op, which is what lets the daemon run a catch-up shortly after every
 *    boot without ever backing up twice a day;
 *  - low-disk skip (WARN): free space must be >= 3x the DB size, because a
 *    backup written onto an almost-full volume is how a stall becomes
 *    corruption (see disk-guard.ts).
 *
 * After each write the *backup file* is verified with PRAGMA quick_check in
 * a worker thread (Part 2) and the outcome recorded in
 * `<dataDir>/backup-integrity.json` — the latest drill-down an operator or a
 * future SLO exporter reads; a failure logs ERROR. The live DB is never
 * opened for the check.
 */
import Database from "better-sqlite3";
import { statfs } from "node:fs";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupDir } from "./backup-rotation.js";
import { runQuickCheckOnFile, type BackupCheckResult } from "./backup-check.js";

/** Matches this job's outputs only — the older date-stamped
 *  canonical-YYYY-MM-DD.sqlite snapshots from `nlm backup` have their own
 *  day-granular rotation (backup-rotation.ts) and are never pruned here. */
const SCHEDULED_RE = /^canonical-(\d{12})\.sqlite$/;

export const BACKUP_KEEP_DEFAULT = 7;
export const BACKUP_INTERVAL_HOURS_DEFAULT = 24;
export const INTEGRITY_STATE_FILENAME = "backup-integrity.json";

export function scheduledBackupEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["NLM_BACKUP"] !== "off";
}

export function backupIntervalMs(env: NodeJS.ProcessEnv): number {
  const h = Number.parseFloat(env["NLM_BACKUP_INTERVAL_HOURS"] ?? "");
  return (Number.isFinite(h) && h > 0 ? h : BACKUP_INTERVAL_HOURS_DEFAULT) * 3_600_000;
}

export function backupKeep(env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env["NLM_BACKUP_KEEP"] ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : BACKUP_KEEP_DEFAULT;
}

/** canonical-<UTC yyyymmddHHMM>.sqlite — zero-padded, so lexicographic
 *  order == chronological order, which is all the rotation needs. */
export function backupStampUTC(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function stampToMs(stamp: string): number {
  return Date.UTC(
    Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)), Number(stamp.slice(10, 12)),
  );
}

/** Given the scheduled filenames present and the keep count, the ones to
 *  delete (everything but the newest `keep`). Pure. */
export function scheduledBackupsToPrune(filenames: ReadonlyArray<string>, keep: number): string[] {
  const stamps = filenames
    .map((f) => SCHEDULED_RE.exec(f)?.[1])
    .filter((s): s is string => s !== undefined)
    .sort();
  return stamps.slice(0, Math.max(0, stamps.length - keep)).map((s) => `canonical-${s}.sqlite`);
}

export interface IntegrityState {
  readonly at: string;
  readonly backup: string;
  readonly ok: boolean;
  readonly checkMs: number;
  readonly error?: string;
}

function writeIntegrityState(dataDir: string, state: IntegrityState): void {
  try {
    writeFileSync(join(dataDir, INTEGRITY_STATE_FILENAME), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // The state file is observability, not the backup itself; a failed
    // record must never fail (or retry) an otherwise-good backup.
  }
}

export type BackupRunStatus = "ok" | "skipped-fresh" | "skipped-low-disk" | "failed";

export interface BackupRunResult {
  readonly status: BackupRunStatus;
  readonly file?: string;
  readonly bytes?: number;
  readonly ms?: number;
  readonly pruned?: ReadonlyArray<string>;
  readonly integrityOk?: boolean;
  readonly reason?: string;
}

export interface BackupRunDeps {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: (msg: string) => void;
  /** Wall clock for the filename stamp and the freshness gate. */
  readonly now?: () => Date;
  /** Monotonic-ish clock for the duration log. */
  readonly elapsed?: () => number;
  /** Free bytes on the volume holding `path`; injectable for tests. */
  readonly freeBytes?: (path: string) => Promise<number>;
  /** Post-write verify of the backup *file*; injectable for tests. */
  readonly quickCheck?: (file: string) => Promise<BackupCheckResult>;
}

function defaultFreeBytes(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    statfs(path, (err, s) => (err ? reject(err) : resolve(s.bavail * s.bsize)));
  });
}

function mib(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** One backup pass. Every branch logs at most one line and returns a
 *  structured result; an unexpected throw (backup API failure) propagates to
 *  the caller's timer wrapper, which logs it — same contract as the other
 *  daemon jobs. */
export async function runScheduledBackup(deps: BackupRunDeps): Promise<BackupRunResult> {
  const env = deps.env ?? process.env;
  const log = deps.logger ?? ((m: string) => console.error(m));
  const nowFn = deps.now ?? (() => new Date());
  const elapsed = deps.elapsed ?? (() => Date.now());
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const quickCheck = deps.quickCheck ?? runQuickCheckOnFile;
  const dataDir = dirname(deps.dbPath);
  const dir = backupDir(deps.dbPath);
  mkdirSync(dir, { recursive: true });

  const intervalMs = backupIntervalMs(env);
  const present = (): string[] => readdirSync(dir).filter((f) => SCHEDULED_RE.test(f));

  // Freshness gate: newest scheduled snapshot still inside the interval.
  const newest = present().sort();
  if (newest.length > 0) {
    const newestName = newest[newest.length - 1]!;
    const stamp = SCHEDULED_RE.exec(newestName)![1]!;
    if (nowFn().getTime() - stampToMs(stamp) < intervalMs) {
      log(`[backup] skipped: ${newestName} is newer than the ${Math.round(intervalMs / 3_600_000)}h interval`);
      return { status: "skipped-fresh", file: newestName };
    }
  }

  // Low-disk gate: a partial backup on a full volume is worse than none.
  // 3x the store (main + WAL + snapshot headroom) is the floor.
  let dbBytes = statSync(deps.dbPath).size;
  try {
    dbBytes += statSync(`${deps.dbPath}-wal`).size;
  } catch {
    // no WAL — normal after a checkpoint or with a non-WAL store
  }
  const free = await freeBytes(deps.dbPath);
  const need = dbBytes * 3;
  if (free < need) {
    log(`[backup] WARN skipped: ${mib(free)} free, need ${mib(need)} (3x db size ${mib(dbBytes)})`);
    return { status: "skipped-low-disk", reason: `free ${free} < 3x db ${dbBytes}` };
  }

  const name = `canonical-${backupStampUTC(nowFn())}.sqlite`;
  const dest = join(dir, name);
  rmSync(dest, { force: true }); // same-minute re-run overwrites instead of failing
  // better-sqlite3's Online Backup API: copies in pages and yields the
  // event loop between steps by default — the whole point of using it here.
  const t0 = elapsed();
  await deps.db.backup(dest);
  const ms = Math.max(0, elapsed() - t0);
  chmodSync(dest, 0o600);
  const bytes = statSync(dest).size;

  const pruned = scheduledBackupsToPrune(present(), backupKeep(env));
  for (const victim of pruned) {
    if (victim === name) continue;
    rmSync(join(dir, victim), { force: true });
  }

  const c0 = elapsed();
  let check: BackupCheckResult;
  try {
    check = await quickCheck(dest);
  } catch (e) {
    check = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const checkMs = Math.max(0, elapsed() - c0);
  writeIntegrityState(dataDir, {
    at: nowFn().toISOString(),
    backup: name,
    ok: check.ok,
    checkMs,
    ...(check.error !== undefined ? { error: check.error } : {}),
  });
  if (!check.ok) {
    log(`[backup] ERROR quick_check FAILED on ${name}: ${check.error ?? "unknown"}`);
  }
  log(`[backup] ${name} ${mib(bytes)} in ${ms}ms check=${check.ok ? "ok" : "FAILED"} pruned=${pruned.length}`);
  return { status: "ok", file: dest, bytes, ms, pruned, integrityOk: check.ok };
}
