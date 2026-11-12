/**
 * T1772 Part 4: the restore drill.
 *
 * A backup that has never been restored is a rumor. `nlm backup
 * restore-drill` proves the newest (or a named) snapshot can actually serve
 * reads: it is *copied* to a temp dir, opened read-only, passed
 * PRAGMA integrity_check, and exercised with three representative queries —
 * session count, an FTS keyword recall, a fact lookup. Like every other
 * corpus read those three go through `tenantClause` (spec §4.2), scoped to
 * the caller's tenant and defaulting to the local team a single-tenant
 * deployment owns. The live DB is only ever read as a directory listing to
 * find the newest backup; nothing under
 * the data dir is written. A drill that fails is the signal to escalate
 * *before* the disaster that would have needed the restore.
 */
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

export interface DrillCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DrillReport {
  readonly ok: boolean;
  readonly backup: string | null;
  readonly checks: DrillCheck[];
}

/** Newest snapshot in `dir` by modification time — mtime sorts across both
 *  filename generations (canonical-YYYY-MM-DD.sqlite from `nlm backup` and
 *  canonical-YYYYMMDDHHMM.sqlite from the scheduled job). */
export function pickNewestBackup(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^canonical-.*\.sqlite$/.test(f));
  } catch {
    return null;
  }
  const dated = names
    .map((f) => {
      const p = join(dir, f);
      try {
        return { p, m: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; m: number } => x !== null)
    .sort((a, b) => b.m - a.m);
  return dated[0]?.p ?? null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run `sql` against the open handle and turn the outcome into a check. */
function queryCheck(
  db: Database.Database,
  name: string,
  sql: string,
  params: readonly unknown[],
  format: (row: Record<string, unknown>) => string,
): DrillCheck {
  try {
    const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
    return { name, ok: true, detail: row ? format(row) : "no rows" };
  } catch (e) {
    return { name, ok: false, detail: errText(e) };
  }
}

/**
 * Copy the backup to a temp dir and prove it serves reads. Never writes to
 * anything but the temp dir, which is always removed — including the
 * copy-failure and query-throw paths.
 */
export function runRestoreDrill(opts: {
  readonly backupFile: string;
  readonly tmpRoot?: string;
  readonly keyword?: string;
  /** Tenant the representative queries are scoped to; defaults to the local team. */
  readonly tenantId?: string;
}): DrillReport {
  const keyword = opts.keyword ?? "memory";
  const tenantId = opts.tenantId ?? DEFAULT_TEAM_ID;
  // One clause per query surface: the sessions reads alias the table `s`
  // (the FTS read must join back to sessions for its tenant filter), the
  // facts read filters its own stamp.
  const sessionsTc = tenantClause(tenantId, "s.tenant_id");
  const factsTc = tenantClause(tenantId);
  const checks: DrillCheck[] = [];
  let tmp: string | null = null;
  let db: Database.Database | null = null;
  try {
    const bytes = statSync(opts.backupFile).size;
    tmp = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "nlm-restore-drill-"));
    const copy = join(tmp, "drill.sqlite");
    copyFileSync(opts.backupFile, copy);

    db = new Database(copy, { readonly: true, fileMustExist: true });

    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      checks.push({
        name: "integrity_check",
        ok: integrity === "ok",
        detail: integrity === "ok" ? `ok (${(bytes / 1_048_576).toFixed(1)} MiB snapshot)` : String(integrity),
      });
    } catch (e) {
      checks.push({ name: "integrity_check", ok: false, detail: errText(e) });
    }

    checks.push(
      queryCheck(
        db,
        "session count",
        `SELECT COUNT(*) AS n FROM sessions s WHERE ${sessionsTc.sql}`,
        [sessionsTc.param],
        (r) => `${r.n} sessions`,
      ),
    );
    checks.push(
      queryCheck(
        db,
        `keyword recall (sessions_fts MATCH "${keyword}")`,
        `SELECT s.rowid FROM sessions_fts
         JOIN sessions s ON s.rowid = sessions_fts.rowid
         WHERE sessions_fts MATCH ? AND ${sessionsTc.sql}
         LIMIT 5`,
        [keyword, sessionsTc.param],
        () => "query served",
      ),
    );
    checks.push(
      queryCheck(
        db,
        "fact lookup",
        `SELECT COUNT(*) AS n FROM facts WHERE ${factsTc.sql}`,
        [factsTc.param],
        (r) => `${r.n} facts`,
      ),
    );
  } catch (e) {
    // Failure before or during copy/open: nothing else could run.
    checks.push({ name: "copy + open", ok: false, detail: errText(e) });
  } finally {
    try {
      db?.close();
    } catch {
      // read-only handle; a close failure cannot affect the live store
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    backup: opts.backupFile ? basename(opts.backupFile) : null,
    checks,
  };
}
