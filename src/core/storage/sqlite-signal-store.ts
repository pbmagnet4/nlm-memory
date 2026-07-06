/**
 * SqliteSignalStore -- canonical SignalStore over the shared better-sqlite3
 * connection (same handle as SqliteSessionStore). Insert is idempotent via
 * INSERT OR IGNORE on the deterministic primary key.
 */

import type Database from "better-sqlite3";
import type { SignalAggregationFilter, SignalStore } from "@ports/signal-store.js";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

type SignalRow = {
  id: string;
  v: number;
  install_scope: string;
  kind: SignalKind;
  producer: string;
  outcome: SignalOutcome;
  model: string;
  repo: string;
  step: string | null;
  detail: string | null;
  session_id: string | null;
  // Optional because read SELECTs stay scope-free while stamping is
  // write-only (#348 Stage A); the insert path always provides it.
  scope?: string | null;
  ts: string;
  created_at: string;
};

const SCAN_CAP = 5000;

export class SqliteSignalStore implements SignalStore {
  constructor(private readonly db: Database.Database) {}

  async insert(signal: Signal): Promise<void> {
    this.insertStmt().run(this.toRow(signal));
  }

  async insertMany(signals: ReadonlyArray<Signal>): Promise<void> {
    if (signals.length === 0) return;
    const stmt = this.insertStmt();
    const txn = this.db.transaction((rows: ReadonlyArray<SignalRow>) => {
      for (const row of rows) stmt.run(row);
    });
    txn(signals.map((s) => this.toRow(s)));
  }

  async listForAggregation(
    filter: SignalAggregationFilter,
  ): Promise<ReadonlyArray<Signal>> {
    const where: string[] = ["install_scope = ?"];
    const params: Array<string | number> = [filter.installScope];
    if (filter.repo !== undefined) { where.push("repo = ?"); params.push(filter.repo); }
    if (filter.model !== undefined) { where.push("model = ?"); params.push(filter.model); }
    if (filter.kind !== undefined) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.sinceTs !== undefined) { where.push("ts >= ?"); params.push(filter.sinceTs); }
    const limit = Math.max(1, Math.min(SCAN_CAP, Math.trunc(filter.limit ?? SCAN_CAP)));
    params.push(limit);
    const rows = this.db
      .prepare<Array<string | number>, SignalRow>(
        `SELECT id, v, install_scope, kind, producer, outcome, model, repo,
                step, detail, session_id, ts, created_at
         FROM signals
         WHERE ${where.join(" AND ")}
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => this.rowToSignal(r));
  }

  async countSince(installScope: string, sinceTs: string): Promise<number> {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM signals WHERE install_scope = ? AND ts >= ?",
      )
      .get(installScope, sinceTs);
    return row?.n ?? 0;
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    const info = this.db.prepare("DELETE FROM signals WHERE ts < ?").run(olderThanTs);
    return info.changes;
  }

  private insertStmt() {
    return this.db.prepare<SignalRow>(`
      INSERT OR IGNORE INTO signals (
        id, v, install_scope, kind, producer, outcome, model, repo,
        step, detail, session_id, scope, ts, created_at
      ) VALUES (
        @id, @v, @install_scope, @kind, @producer, @outcome, @model, @repo,
        @step, @detail, @session_id, @scope, @ts, @created_at
      )
    `);
  }

  private toRow(s: Signal): SignalRow {
    return {
      id: s.id,
      v: s.v,
      install_scope: s.installScope,
      kind: s.kind,
      producer: s.producer,
      outcome: s.outcome,
      model: s.model,
      repo: s.repo,
      step: s.step,
      detail: s.detail === null ? null : JSON.stringify(s.detail),
      session_id: s.sessionId,
      scope: s.scope,
      ts: s.ts,
      created_at: s.createdAt,
    };
  }

  private rowToSignal(row: SignalRow): Signal {
    return {
      id: row.id,
      v: row.v,
      installScope: row.install_scope,
      kind: row.kind,
      producer: row.producer,
      outcome: row.outcome,
      model: row.model,
      repo: row.repo,
      step: row.step,
      detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>),
      sessionId: row.session_id,
      scope: row.scope ?? null,
      ts: row.ts,
      createdAt: row.created_at,
    };
  }
}
