/**
 * `nlm scope coverage`: per-table and recall-weighted scope coverage fractions.
 *
 * READ-ONLY: opens the DB with { readonly: true }; never writes.
 * No env flags consulted. No recall behavior change.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recentQueryLog } from "../core/recall/recent-log.js";

export interface TableCoverage {
  total: number;
  stamped: number;
  unstamped: number;
  stamped_fraction: number;
  byScope: Record<string, number>;
}

export interface OverallCoverage {
  total: number;
  stamped: number;
  unstamped: number;
  stamped_fraction: number;
}

export interface RecallWeightedStats {
  distinctReturnedIds: number;
  foundInDb: number;
  scoped: number;
  fraction: number;
}

export interface RecallWeightedCoverage extends RecallWeightedStats {
  // Per-surface = grouped by the query log's `source` field (hook, mcp, http, ...).
  bySurface: Record<string, RecallWeightedStats>;
}

export interface CoverageResult {
  sessions: TableCoverage;
  facts: TableCoverage;
  code_exemplars: TableCoverage;
  signals: TableCoverage;
  workstreams: TableCoverage;
  overall: OverallCoverage;
  recallWeighted: RecallWeightedCoverage | null;
  queryLogNote: string | null;
}

function overallOf(tables: ReadonlyArray<TableCoverage>): OverallCoverage {
  let total = 0;
  let stamped = 0;
  for (const t of tables) {
    total += t.total;
    stamped += t.stamped;
  }
  return {
    total,
    stamped,
    unstamped: total - stamped,
    stamped_fraction: total === 0 ? 0 : stamped / total,
  };
}

function tableStats(db: Database.Database, table: string): TableCoverage {
  type AggRow = { total: number; scoped: number | null };
  const agg = db
    .prepare<[], AggRow>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN scope IS NOT NULL THEN 1 ELSE 0 END) AS scoped FROM "${table}"`,
    )
    .get()!;
  const total = agg.total;
  const scoped = agg.scoped ?? 0;

  type ByScopeRow = { scope: string; n: number };
  const rows = db
    .prepare<[], ByScopeRow>(
      `SELECT scope, COUNT(*) AS n FROM "${table}" WHERE scope IS NOT NULL GROUP BY scope`,
    )
    .all();
  const byScope: Record<string, number> = {};
  for (const { scope, n } of rows) {
    byScope[scope] = n;
  }

  return {
    total,
    stamped: scoped,
    unstamped: total - scoped,
    stamped_fraction: total === 0 ? 0 : scoped / total,
    byScope,
  };
}

function defaultQueryLogPath(): string {
  return process.env["NLM_QUERY_LOG"] ?? join(homedir(), ".nlm", "query_log.jsonl");
}

const CHUNK_SIZE = 999;

export async function runScopeCoverage(opts: {
  dbPath: string;
  queryLogPath?: string;
  window?: number;
}): Promise<CoverageResult> {
  const entryWindow = opts.window ?? 200;
  if (!Number.isFinite(entryWindow) || entryWindow <= 0) {
    throw new Error(`invalid --window: ${String(opts.window)} (expected a positive integer)`);
  }
  const db = new Database(opts.dbPath, { readonly: true });

  try {
    const sessions = tableStats(db, "sessions");
    const facts = tableStats(db, "facts");
    const code_exemplars = tableStats(db, "code_exemplars");
    const signals = tableStats(db, "signals");
    const workstreams = tableStats(db, "workstreams");
    const overall = overallOf([sessions, facts, code_exemplars, signals, workstreams]);

    const logPath = opts.queryLogPath ?? defaultQueryLogPath();

    if (!existsSync(logPath)) {
      return {
        sessions,
        facts,
        code_exemplars,
        signals,
        workstreams,
        overall,
        recallWeighted: null,
        queryLogNote: `query log not found at ${logPath}`,
      };
    }

    const entries = recentQueryLog(entryWindow, logPath);
    const idSet = new Set<string>();
    const idsBySurface = new Map<string, Set<string>>();
    for (const entry of entries) {
      let surfaceIds = idsBySurface.get(entry.source);
      if (!surfaceIds) {
        surfaceIds = new Set<string>();
        idsBySurface.set(entry.source, surfaceIds);
      }
      for (const id of entry.returnedIds) {
        idSet.add(id);
        surfaceIds.add(id);
      }
    }

    if (idSet.size === 0) {
      return {
        sessions,
        facts,
        code_exemplars,
        signals,
        workstreams,
        overall,
        recallWeighted: { distinctReturnedIds: 0, foundInDb: 0, scoped: 0, fraction: 0, bySurface: {} },
        queryLogNote: null,
      };
    }

    // Recalled ids span the corpus tables (session recall returns session
    // ids, fact recall fact ids, code recall exemplar ids); resolve each id
    // to its scope across all three, first match wins.
    const scopeById = new Map<string, string | null>();
    const ids = [...idSet];
    for (const table of ["sessions", "facts", "code_exemplars"]) {
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE).filter((id) => !scopeById.has(id));
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
          .prepare(`SELECT id, scope FROM "${table}" WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; scope: string | null }>;
        for (const row of rows) {
          if (!scopeById.has(row.id)) scopeById.set(row.id, row.scope);
        }
      }
    }

    const statsFor = (set: ReadonlySet<string>): RecallWeightedStats => {
      let foundInDb = 0;
      let scoped = 0;
      for (const id of set) {
        const scope = scopeById.get(id);
        if (scope === undefined) continue;
        foundInDb++;
        if (scope !== null) scoped++;
      }
      return {
        distinctReturnedIds: set.size,
        foundInDb,
        scoped,
        fraction: foundInDb === 0 ? 0 : scoped / foundInDb,
      };
    };

    const bySurface: Record<string, RecallWeightedStats> = {};
    for (const [source, surfaceIds] of idsBySurface) {
      if (surfaceIds.size > 0) bySurface[source] = statsFor(surfaceIds);
    }

    return {
      sessions,
      facts,
      code_exemplars,
      signals,
      workstreams,
      overall,
      recallWeighted: { ...statsFor(idSet), bySurface },
      queryLogNote: null,
    };
  } finally {
    db.close();
  }
}

export function formatCoverageResult(result: CoverageResult, write: (s: string) => void): void {
  write("scope coverage:\n\n");
  write("  per-table:\n");

  const tables: Array<[string, TableCoverage]> = [
    ["sessions", result.sessions],
    ["facts", result.facts],
    ["code_exemplars", result.code_exemplars],
    ["signals", result.signals],
    ["workstreams", result.workstreams],
  ];

  for (const [name, cov] of tables) {
    const pct = `${(cov.stamped_fraction * 100).toFixed(1)}%`;
    const counts = `${cov.stamped}/${cov.total} stamped (${pct})`;
    const entries = Object.entries(cov.byScope);
    const breakdown =
      entries.length > 0
        ? `  [${entries.map(([s, c]) => `${s}: ${c}`).join(", ")}]`
        : "";
    write(`    ${name.padEnd(15)} ${counts}${breakdown}\n`);
  }

  const o = result.overall;
  const overallPct = `${(o.stamped_fraction * 100).toFixed(1)}%`;
  write(`    ${"overall".padEnd(15)} ${o.stamped}/${o.total} stamped (${overallPct})\n`);

  write("\n");

  if (result.queryLogNote !== null) {
    write(`  recall-weighted: skipped -- ${result.queryLogNote}\n`);
  } else if (result.recallWeighted !== null) {
    const rw = result.recallWeighted;
    const pct = `${(rw.fraction * 100).toFixed(1)}%`;
    write(`  recall-weighted (recalled ids from last window):\n`);
    write(`    distinct ids: ${rw.distinctReturnedIds}\n`);
    write(`    found in db:  ${rw.foundInDb}\n`);
    write(`    scoped:       ${rw.scoped}\n`);
    write(`    fraction:     ${pct}\n`);
    const surfaces = Object.entries(rw.bySurface);
    if (surfaces.length > 0) {
      write(`  per-surface:\n`);
      for (const [source, s] of surfaces) {
        const sPct = `${(s.fraction * 100).toFixed(1)}%`;
        write(`    ${source.padEnd(15)} ${s.scoped}/${s.foundInDb} scoped (${sPct}, ${s.distinctReturnedIds} ids)\n`);
      }
    }
  }
}
