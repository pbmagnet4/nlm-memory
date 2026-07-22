/**
 * SqliteSignalStore -- canonical SignalStore over the shared better-sqlite3
 * connection (same handle as SqliteSessionStore). Insert is idempotent via
 * INSERT OR IGNORE on the deterministic primary key.
 *
 * Tenancy (program spec §4, M2 plan Wave B4): every method takes `tenantId`
 * as its non-optional first parameter. `signals` is a STAMP table; every
 * SELECT/DELETE routes its WHERE fragment through `tenantClause`, and
 * INSERTs stamp `tenant_id` explicitly. `install_scope` remains the
 * within-tenant discriminator (program spec §4.6 hardening 3) — tenantId is
 * the outer mandatory filter, installScope narrows further inside it.
 */

import type Database from "better-sqlite3";
import type { SignalAggregationFilter, SignalStore } from "@ports/signal-store.js";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

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

  async insert(tenantId: string, signal: Signal): Promise<void> {
    this.insertStmt().run(this.toRow(signal, tenantId));
  }

  async insertMany(tenantId: string, signals: ReadonlyArray<Signal>): Promise<void> {
    if (signals.length === 0) return;
    const stmt = this.insertStmt();
    const txn = this.db.transaction((rows: ReadonlyArray<SignalRow & { tenant_id: string }>) => {
      for (const row of rows) stmt.run(row);
    });
    txn(signals.map((s) => this.toRow(s, tenantId)));
  }

  async listForAggregation(
    tenantId: string,
    filter: SignalAggregationFilter,
  ): Promise<ReadonlyArray<Signal>> {
    const tc = tenantClause(tenantId);
    const where: string[] = ["install_scope = ?", tc.sql];
    const params: Array<string | number> = [filter.installScope, tc.param];
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

  async countSince(tenantId: string, installScope: string, sinceTs: string): Promise<number> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare<[string, string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM signals WHERE install_scope = ? AND ts >= ? AND ${tc.sql}`,
      )
      .get(installScope, sinceTs, tc.param);
    return row?.n ?? 0;
  }

  async pruneOlderThan(tenantId: string, olderThanTs: string): Promise<number> {
    const tc = tenantClause(tenantId);
    const info = this.db.prepare(`DELETE FROM signals WHERE ts < ? AND ${tc.sql}`).run(olderThanTs, tc.param);
    return info.changes;
  }

  private insertStmt() {
    return this.db.prepare<SignalRow & { tenant_id: string }>(`
      INSERT OR IGNORE INTO signals (
        id, v, install_scope, kind, producer, outcome, model, repo,
        step, detail, session_id, scope, ts, created_at, tenant_id
      ) VALUES (
        @id, @v, @install_scope, @kind, @producer, @outcome, @model, @repo,
        @step, @detail, @session_id, @scope, @ts, @created_at, @tenant_id
      )
    `);
  }

  private toRow(s: Signal, tenantId: string): SignalRow & { tenant_id: string } {
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
      tenant_id: tenantId,
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
