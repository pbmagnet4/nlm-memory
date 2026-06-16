/**
 * Rolling daily backups of the canonical store.
 *
 * A dated snapshot (`canonical-YYYY-MM-DD.sqlite`) is written via VACUUM INTO
 * (live-consistent, see db-restore.vacuumSnapshot) into `<dbDir>/backups/`, and
 * snapshots older than the retention window are pruned. This is the worst-case
 * mitigation: a bad migration that silently corrupts canonical.sqlite is
 * recoverable from yesterday's snapshot via `nlm restore --from <date>`.
 *
 * The date arithmetic (which snapshots to prune, filename <-> date) is pure and
 * unit-tested; the IO wrapper lives in `runRollingBackup`.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { vacuumSnapshot } from "./db-restore.js";

const FILENAME_RE = /^canonical-(\d{4}-\d{2}-\d{2})\.sqlite$/;

export function backupDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export function backupFilename(date: string): string {
  return `canonical-${date}.sqlite`;
}

/** Extract the YYYY-MM-DD date from a backup filename, or null if it isn't one. */
export function parseBackupDate(filename: string): string | null {
  const m = FILENAME_RE.exec(filename);
  return m ? m[1]! : null;
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Given the backup filenames present, the retention window, and today's date,
 * return the filenames to delete — those whose date is more than
 * `retentionDays` before `today`. Non-backup filenames are ignored. Pure.
 */
export function backupsToPrune(
  filenames: ReadonlyArray<string>,
  retentionDays: number,
  today: string,
): string[] {
  return filenames.filter((name) => {
    const date = parseBackupDate(name);
    if (date === null) return false;
    return daysBetween(date, today) >= retentionDays;
  });
}

export interface RollingBackupResult {
  readonly written: string;
  readonly bytes: number;
  readonly pruned: ReadonlyArray<string>;
}

/**
 * Write today's snapshot and prune expired ones. `today` is injected
 * (YYYY-MM-DD) so the rotation is deterministic and testable. Idempotent: a
 * second call on the same day overwrites the day's snapshot.
 */
export function runRollingBackup(
  db: Database.Database,
  dbPath: string,
  today: string,
  retentionDays: number,
): RollingBackupResult {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });

  const dest = join(dir, backupFilename(today));
  const bytes = vacuumSnapshot(db, dest);

  const present = readdirSync(dir);
  const pruned = backupsToPrune(present, retentionDays, today);
  for (const name of pruned) {
    if (name === backupFilename(today)) continue; // never prune the one just written
    rmSync(join(dir, name), { force: true });
  }

  return { written: dest, bytes, pruned };
}

/** Resolve the snapshot file for a given date, or null if absent. */
export function resolveBackup(dbPath: string, date: string): string | null {
  const path = join(backupDir(dbPath), backupFilename(date));
  return existsSync(path) ? path : null;
}

/** List available backup dates (descending), for error messages and `--list`. */
export function listBackupDates(dbPath: string): string[] {
  const dir = backupDir(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(parseBackupDate)
    .filter((d): d is string => d !== null)
    .sort()
    .reverse();
}
