/**
 * T1772: off-thread integrity verification of a backup *file*.
 *
 * `PRAGMA quick_check` over a ~2 GB store takes seconds of pure sync CPU in
 * whichever thread runs it; on the daemon's main thread that is an event-loop
 * freeze of exactly the kind T1757 instrumented. So the check runs in a
 * worker thread (backup-check-worker.ts) against the snapshot file — the
 * live DB is never opened here.
 */
import { Worker } from "node:worker_threads";

export interface BackupCheckResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Run PRAGMA quick_check on `file` in a worker thread. Resolves; only a
 *  worker-level failure (spawn/exit) rejects. */
export function runQuickCheckOnFile(file: string): Promise<BackupCheckResult> {
  const entry = new URL("./backup-check-worker.js", import.meta.url);
  const source = import.meta.url.endsWith(".ts");
  const url = source
    ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)}); const { register } = require('tsx/esm/api'); register(); await import(${JSON.stringify(entry.href.replace(/\.js$/, ".ts"))});`,
    )}`)
    : entry;
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { file } });
    worker.once("message", (reply: BackupCheckResult) => {
      resolve(reply);
    });
    worker.once("error", (err) => reject(err));
    worker.once("exit", (code) => {
      reject(new Error(`backup check worker exited before answering (code ${code})`));
    });
  });
}
