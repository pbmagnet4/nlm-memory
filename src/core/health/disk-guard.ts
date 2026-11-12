/**
 * T1772 Part 3: the disk guard.
 *
 * The daemon stalled writes near 99% disk because SQLite surfaces a full
 * volume as an SQLITE_FULL error storm rather than a decision. This makes it
 * a decision: every *write-heavy* job tick (ingest scheduler tick, embed
 * sweeps, dream passes, the scheduled backup — the backup has its own
 * stricter 3x-DB-size floor) asks the guard first, and below the floor the
 * tick is skipped with one WARN per hour instead of an error storm. Read
 * paths — recall, /api/recall — are deliberately never gated: serving recall
 * from a nearly-full disk is fine, corrupting it by writing into ENOSPC is
 * not.
 *
 * The floor is the larger of two thresholds:
 *   NLM_DISK_MIN_FREE_PCT (default 2)  — percent of the volume's total size
 *   NLM_DISK_MIN_FREE_GB  (default 5)  — absolute floor in GiB
 * so a 2% floor on a tiny boot volume does not license writing down to a
 * hundred free megabytes.
 */
import { statfs } from "node:fs";

export const DISK_MIN_FREE_PCT_DEFAULT = 2;
export const DISK_MIN_FREE_GB_DEFAULT = 5;

export interface DiskGuardStatus {
  /** Bytes available to unprivileged writers (statfs bavail). */
  readonly free: number;
  /** The effective floor both thresholds resolve to, in bytes. */
  readonly threshold: number;
  readonly tripped: boolean;
  /** Wall ms of the check that produced this snapshot. */
  readonly checkedAt: number;
}

interface StatfsLike {
  readonly bsize: number;
  readonly bavail: number;
  readonly blocks: number;
}

export interface DiskGuard {
  /** True = skip this write-heavy tick. Records the snapshot for `status()`
   *  and emits at most one WARN per hour across all jobs. */
  shouldSkip(job: string): Promise<boolean>;
  /** Last computed snapshot for GET /api/health; null until the first check. */
  status(): DiskGuardStatus | null;
}

export function diskThresholds(env: NodeJS.ProcessEnv): { minFreePct: number; minFreeGb: number } {
  const pct = Number.parseFloat(env["NLM_DISK_MIN_FREE_PCT"] ?? "");
  const gb = Number.parseFloat(env["NLM_DISK_MIN_FREE_GB"] ?? "");
  return {
    minFreePct: Number.isFinite(pct) && pct >= 0 ? pct : DISK_MIN_FREE_PCT_DEFAULT,
    minFreeGb: Number.isFinite(gb) && gb >= 0 ? gb : DISK_MIN_FREE_GB_DEFAULT,
  };
}

const GIB = 1024 ** 3;
const WARN_INTERVAL_MS = 3_600_000;

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function createDiskGuard(opts: {
  /** Path whose volume is checked — the canonical DB file. */
  readonly path: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: (msg: string) => void;
  readonly now?: () => number;
  readonly stat?: (path: string) => Promise<StatfsLike>;
}): DiskGuard {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? ((m: string) => console.error(m));
  const now = opts.now ?? (() => Date.now());
  const stat = opts.stat ?? ((p: string) => new Promise<StatfsLike>((resolve, reject) => {
    statfs(p, (err, s) => (err ? reject(err) : resolve(s)));
  }));
  let last: DiskGuardStatus | null = null;
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  async function check(): Promise<DiskGuardStatus | null> {
    try {
      const s = await stat(opts.path);
      const { minFreePct, minFreeGb } = diskThresholds(env);
      const total = s.blocks * s.bsize;
      const threshold = Math.max((total * minFreePct) / 100, minFreeGb * GIB);
      last = { free: s.bavail * s.bsize, threshold, tripped: s.bavail * s.bsize < threshold, checkedAt: now() };
      return last;
    } catch (e) {
      // A failed free-space probe must not gate the daemon's whole write
      // lane on an OS quirk; log once per WARN window and let the job run.
      if (now() - lastWarnAt >= WARN_INTERVAL_MS) {
        lastWarnAt = now();
        log(`[disk-guard] WARN free-space check failed (${e instanceof Error ? e.message : String(e)}); proceeding`);
      }
      return null;
    }
  }

  return {
    async shouldSkip(job: string): Promise<boolean> {
      const s = await check();
      if (!s || !s.tripped) return false;
      if (now() - lastWarnAt >= WARN_INTERVAL_MS) {
        lastWarnAt = now();
        log(`[disk-guard] WARN ${gib(s.free)} free, floor ${gib(s.threshold)}: pausing writes until space frees up (skipped ${job})`);
      }
      return true;
    },
    status: () => last,
  };
}
