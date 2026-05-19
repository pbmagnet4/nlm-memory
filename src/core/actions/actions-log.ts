/**
 * actions-log — append-only event source for every interactive change.
 *
 * The actions table is canonical: dismiss/snooze/retire/label/merge are
 * all rows here, never destructive mutations elsewhere. Dataset projection
 * (build-dataset.ts) reads this table to overlay user-driven state on top
 * of the persisted store. Ports server.py's _write_action + undo flow.
 */

import type Database from "better-sqlite3";

export interface ActionInput {
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload?: Record<string, unknown>;
  readonly actor?: string;
  readonly runtime?: string;
}

export interface ActionRow {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly payload: Record<string, unknown> | null;
  readonly actor: string;
  readonly runtime: string | null;
  readonly reverted_by: string | null;
}

function makeActionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 10);
  return `act_${ts}_${rand}`;
}

export function writeAction(db: Database.Database, input: ActionInput): string {
  const id = makeActionId();
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  db.prepare(`
    INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    input.kind,
    input.subjectType,
    input.subjectId,
    payload,
    input.actor ?? "user",
    input.runtime ?? "api",
  );
  return id;
}

export function writeActionsBatch(db: Database.Database, inputs: ReadonlyArray<ActionInput>): string[] {
  const txn = db.transaction((rows: ReadonlyArray<ActionInput>) => rows.map((r) => writeAction(db, r)));
  return txn(inputs);
}

export interface UndoResult {
  readonly undoId: string;
  readonly originalKind: string;
}

export function undoAction(db: Database.Database, actionId: string): UndoResult | null {
  const target = db
    .prepare<[string], { id: string; kind: string; subject_type: string; subject_id: string }>(
      "SELECT id, kind, subject_type, subject_id FROM actions WHERE id = ? AND reverted_by IS NULL",
    )
    .get(actionId);
  if (!target) return null;

  const undoId = makeActionId();
  const undoPayload = JSON.stringify({
    undone_kind: target.kind,
    undone_subject: `${target.subject_type}:${target.subject_id}`,
  });
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
      VALUES (?, ?, 'undo', 'action', ?, ?, 'user', 'api')
    `).run(undoId, new Date().toISOString(), actionId, undoPayload);
    db.prepare("UPDATE actions SET reverted_by = ? WHERE id = ?").run(undoId, actionId);
  });
  txn();
  return { undoId, originalKind: target.kind };
}

export function listActions(
  db: Database.Database,
  opts: { limit?: number; subjectId?: string; kind?: string } = {},
): ActionRow[] {
  const limit = opts.limit ?? 100;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.subjectId) {
    where.push("subject_id = ?");
    params.push(opts.subjectId);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by
    FROM actions
    ${whereSql}
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  params.push(limit);
  const rows = db.prepare<unknown[], ActionRow & { payload: string | null }>(sql).all(...params);
  return rows.map((r) => ({ ...r, payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null }));
}
