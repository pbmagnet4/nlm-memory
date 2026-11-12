/**
 * T1772 backup check worker: runs PRAGMA quick_check on a backup *file*
 * (never the live DB) in its own thread, so a multi-second full B-tree scan
 * on a ~2 GB store cannot block the daemon's event loop. Opened read-only —
 * a check that could write to the snapshot it is meant to certify is a bug.
 *
 * Spawned one-shot by `runQuickCheckOnFile` in backup-check.ts; mirrors the
 * tsx-aware spawn pattern of sqlite-semantic-reader.ts.
 */
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

export interface BackupCheckReply {
  readonly ok: boolean;
  readonly error?: string;
}

const db = new Database(workerData.file, { readonly: true, fileMustExist: true });
try {
  const rows = db.pragma("quick_check") as Array<Record<string, string>>;
  const bad = rows.filter((r) => Object.values(r)[0] !== "ok");
  const reply: BackupCheckReply = bad.length === 0
    ? { ok: true }
    : { ok: false, error: bad.slice(0, 3).map((r) => Object.values(r)[0]).join("; ") };
  parentPort!.postMessage(reply);
} catch (e) {
  parentPort!.postMessage({
    ok: false,
    error: e instanceof Error ? e.message : String(e),
  } satisfies BackupCheckReply);
} finally {
  db.close();
}
