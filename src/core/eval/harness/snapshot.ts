/**
 * Frozen, dated, read-only copy of the live store for experiments. The database
 * goes through SQLite's online backup API (a raw file copy of a WAL database
 * can tear); the append-only JSONL logs are plain copies. The snapshot lives
 * outside the repo and is never overwritten.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const SNAPSHOT_LOGS = [
  "query_log.jsonl",
  "fact_query_log.jsonl",
  "citation-log.jsonl",
  "hook-log.jsonl",
] as const;

export interface SnapshotOptions {
  readonly sourceDb: string;
  readonly logsDir: string;
  readonly outDir: string;
}

export interface SnapshotResult {
  readonly dir: string;
  readonly db: string;
  readonly logs: ReadonlyArray<string>;
  readonly missingLogs: ReadonlyArray<string>;
}

export async function createSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  if (existsSync(opts.outDir)) {
    throw new Error(`snapshot already exists, refusing to overwrite: ${opts.outDir}`);
  }
  if (!existsSync(opts.sourceDb)) throw new Error(`source database not found: ${opts.sourceDb}`);
  mkdirSync(opts.outDir, { recursive: true });
  const dest = join(opts.outDir, "canonical.sqlite");
  const src = new Database(opts.sourceDb, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
  // Leave the copy in rollback-journal mode so readers never need -wal/-shm files beside it.
  const copy = new Database(dest);
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  chmodSync(dest, 0o444);
  const logs: string[] = [];
  const missingLogs: string[] = [];
  for (const name of SNAPSHOT_LOGS) {
    const from = join(opts.logsDir, name);
    if (!existsSync(from)) {
      missingLogs.push(name);
      continue;
    }
    const to = join(opts.outDir, name);
    copyFileSync(from, to);
    chmodSync(to, 0o444);
    logs.push(name);
  }
  return { dir: opts.outDir, db: dest, logs, missingLogs };
}
