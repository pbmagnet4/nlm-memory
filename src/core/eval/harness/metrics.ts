/**
 * Store and log metrics for the eval harness. Everything here reads a sandbox
 * copy of a snapshot (database) or snapshot log text; nothing touches the live
 * store.
 */

import type Database from "better-sqlite3";
import { countActiveFactConflicts } from "../../integrity/check-invariants.js";

export function percentile(sorted: ReadonlyArray<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export interface FactHealth {
  readonly activeFacts: number;
  /** Conflicting (subject, predicate) groups, doctor I5a logic and exempt set. */
  readonly conflictingActiveFacts: number;
  /** Exempt multi-valued groups holding several active facts (doctor I5a-mv, informational). */
  readonly multiValuedGroups: number;
  readonly activeFactsMissingEmbedding: number;
  readonly missingEmbeddingShare: number;
}

/**
 * Missing-embedding share: active facts with no row in the vec0 table's rowids
 * shadow table, the same discovery-by-absence the embed backfill uses. The
 * rowids table is the one the doctor's I7 joins, so a fact is counted once.
 */
export function factHealth(db: Database.Database): FactHealth {
  const active = (db.prepare("SELECT count(*) AS n FROM facts WHERE superseded_by IS NULL AND retired_at IS NULL").get() as { n: number }).n;
  const missing = (
    db
      .prepare(
        `SELECT count(*) AS n FROM facts f
          WHERE f.superseded_by IS NULL AND f.retired_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM fact_embeddings_rowids r WHERE r.id = f.id)`,
      )
      .get() as { n: number }
  ).n;
  const { conflicts, multiValuedGroups } = countActiveFactConflicts(db);
  return {
    activeFacts: active,
    conflictingActiveFacts: conflicts,
    multiValuedGroups,
    activeFactsMissingEmbedding: missing,
    missingEmbeddingShare: active === 0 ? 0 : missing / active,
  };
}

/** Bytes per logical table: indexes, FTS5 and vec0 shadow tables roll up to their owner. */
export function dbSizeByTable(db: Database.Database): Record<string, number> {
  const master = db.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master").all() as Array<{
    name: string;
    tbl: string;
    sql: string | null;
  }>;
  const virtuals = master
    .filter((m) => /^CREATE VIRTUAL TABLE/i.test(m.sql ?? ""))
    .map((m) => m.name)
    .sort((a, b) => b.length - a.length);
  const ownerOfTable = (tbl: string): string =>
    virtuals.find((v) => tbl === v || tbl.startsWith(`${v}_`)) ?? tbl;
  const tblOf = new Map(master.map((m) => [m.name, m.tbl]));
  const out: Record<string, number> = {};
  const rows = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all() as Array<{
    name: string;
    bytes: number;
  }>;
  for (const r of rows) {
    const owner = ownerOfTable(tblOf.get(r.name) ?? r.name);
    out[owner] = (out[owner] ?? 0) + r.bytes;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export interface HookTokens {
  readonly calls: number;
  readonly injectingCalls: number;
  readonly totalTokens: number;
  readonly meanPerCall: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p50Injecting: number | null;
  readonly p95Injecting: number | null;
}

/** Tokens injected per hook call, from `estTokens` on recall-hook log records. */
export function hookTokens(hookLogText: string): HookTokens {
  const all: number[] = [];
  for (const line of hookLogText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { estTokens?: unknown };
      if (typeof r.estTokens === "number") all.push(r.estTokens);
    } catch {
      continue;
    }
  }
  const sorted = [...all].sort((a, b) => a - b);
  const inj = sorted.filter((t) => t > 0);
  const total = all.reduce((a, b) => a + b, 0);
  return {
    calls: all.length,
    injectingCalls: inj.length,
    totalTokens: total,
    meanPerCall: all.length === 0 ? null : total / all.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p50Injecting: percentile(inj, 0.5),
    p95Injecting: percentile(inj, 0.95),
  };
}
