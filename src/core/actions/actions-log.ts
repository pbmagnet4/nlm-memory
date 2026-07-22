/**
 * actions-log — append-only event source for every interactive change.
 *
 * The actions table is canonical: dismiss/snooze/retire/label/merge are
 * all rows here, never destructive mutations elsewhere. Dataset projection
 * (build-dataset.ts) reads this table to overlay user-driven state on top
 * of the persisted store. Ports server.py's _write_action + undo flow.
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";

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

function actionDedupeKey(input: ActionInput): string {
  return JSON.stringify([input.kind, input.subjectType, input.subjectId, input.payload ?? null]);
}

/**
 * Collapses identical rows (same kind + subjectType + subjectId + payload)
 * within a single batch, keeping the first occurrence. A batch is typically
 * one UI gesture replayed by a flaky client retry, not intentionally repeated
 * writes, so silently dropping the duplicates is the correct behavior rather
 * than inserting redundant log rows.
 */
export function dedupeActionInputs(inputs: ReadonlyArray<ActionInput>): ActionInput[] {
  const seen = new Set<string>();
  const out: ActionInput[] = [];
  for (const input of inputs) {
    const key = actionDedupeKey(input);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(input);
  }
  return out;
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
  const deduped = dedupeActionInputs(inputs);
  const txn = db.transaction((rows: ReadonlyArray<ActionInput>) => rows.map((r) => writeAction(db, r)));
  return txn(deduped);
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
  // An 'undo' row is itself unrevertable: reverting it wouldn't restore the
  // original action (reverted_by on the original stays pointed at it), so it
  // would just be a dead row. Reject cleanly with the same "not found or
  // already undone" contract the caller already handles.
  if (!target || target.kind === "undo") return null;

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

// ---------------------------------------------------------------------------
// PG-native counterparts
// ---------------------------------------------------------------------------

export async function writeActionPg(pool: Pool, input: ActionInput): Promise<string> {
  const id = makeActionId();
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  await pool.query(
    `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, new Date().toISOString(), input.kind, input.subjectType, input.subjectId,
     payload, input.actor ?? "user", input.runtime ?? "api"],
  );
  return id;
}

export async function writeActionsBatchPg(pool: Pool, inputs: ReadonlyArray<ActionInput>): Promise<string[]> {
  const deduped = dedupeActionInputs(inputs);
  if (deduped.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids: string[] = [];
    for (const input of deduped) {
      const id = makeActionId();
      const payload = input.payload ? JSON.stringify(input.payload) : null;
      await client.query(
        `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, new Date().toISOString(), input.kind, input.subjectType, input.subjectId,
         payload, input.actor ?? "user", input.runtime ?? "api"],
      );
      ids.push(id);
    }
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function undoActionPg(pool: Pool, actionId: string): Promise<UndoResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{ id: string; kind: string; subject_type: string; subject_id: string }>(
      "SELECT id, kind, subject_type, subject_id FROM actions WHERE id = $1 AND reverted_by IS NULL FOR UPDATE",
      [actionId],
    );
    // See undoAction's sqlite counterpart: an 'undo' row can't itself be
    // undone without leaving a dead row that doesn't restore anything.
    if (!target.rows[0] || target.rows[0].kind === "undo") {
      await client.query("ROLLBACK");
      return null;
    }
    const t = target.rows[0];
    const undoId = makeActionId();
    const undoPayload = JSON.stringify({ undone_kind: t.kind, undone_subject: `${t.subject_type}:${t.subject_id}` });
    await client.query(
      `INSERT INTO actions (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime)
       VALUES ($1, $2, 'undo', 'action', $3, $4, 'user', 'api')`,
      [undoId, new Date().toISOString(), actionId, undoPayload],
    );
    await client.query("UPDATE actions SET reverted_by = $1 WHERE id = $2", [undoId, actionId]);
    await client.query("COMMIT");
    return { undoId, originalKind: t.kind };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listActionsPg(
  pool: Pool,
  opts: { limit?: number; subjectId?: string; kind?: string } = {},
): Promise<ActionRow[]> {
  const limit = opts.limit ?? 100;
  const where: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.subjectId) { where.push(`subject_id = $${idx++}`); params.push(opts.subjectId); }
  if (opts.kind) { where.push(`kind = $${idx++}`); params.push(opts.kind); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);
  const result = await pool.query<ActionRow & { payload: string | null }>(
    `SELECT id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by
     FROM actions ${whereSql}
     ORDER BY timestamp DESC LIMIT $${idx}`,
    params,
  );
  return result.rows.map((r) => ({
    ...r,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  }));
}
