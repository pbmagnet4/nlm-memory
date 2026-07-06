/**
 * `nlm scope backfill`: derive and stamp scope on legacy corpus rows.
 *
 * Cascade order: sessions -> facts -> exemplars -> signals -> workstreams.
 * --dry-run (default): computes would-change counts and writes nothing.
 * --apply: writes; only fills scope IS NULL rows; idempotent.
 */

import { open } from "node:fs/promises";
import Database from "better-sqlite3";
import { deriveScope } from "../core/scope/derive-scope.js";
import type { AliasMap } from "../core/scope/alias-map.js";

/** Read at most this many bytes from the head of a transcript to find cwd. */
const HEAD_BYTES = 8_192;

/**
 * Bounded head-read that matches the claude-code adapter's cwd extraction
 * exactly (src/core/adapters/claude-code.ts:144):
 *   if (!projectDir && typeof evt["cwd"] === "string") projectDir = evt["cwd"];
 *
 * Also covers pi-runtime JSONL: the pi adapter reads cwd from the
 * `type: "session"` event on line 1 (src/core/adapters/pi.ts:124-126);
 * taking the first `cwd` field on any line subsumes that shape.
 *
 * Reads at most HEAD_BYTES from the file start, splits into lines, parses
 * each as JSON, and returns the value of the first "cwd" string field found.
 * A first line longer than HEAD_BYTES arrives truncated, fails JSON.parse,
 * and is skipped: fail-closed to NULL, never a mis-parse.
 */
async function readCwdFromTranscript(
  transcriptPath: string,
): Promise<{ cwd: string | null; skipReason?: "missing" | "malformed" }> {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(transcriptPath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.toString("utf8", 0, bytesRead);
    for (const line of head.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof evt["cwd"] === "string" && evt["cwd"]) {
        return { cwd: evt["cwd"] };
      }
    }
    return { cwd: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const skipReason: "missing" | "malformed" =
      code === "ENOENT" || code === "EACCES" || code === "EPERM"
        ? "missing"
        : "malformed";
    return { cwd: null, skipReason };
  } finally {
    await fd?.close().catch(() => {});
  }
}

type ScopeCount = Record<string, number>;

function inc(counter: ScopeCount, scope: string): void {
  counter[scope] = (counter[scope] ?? 0) + 1;
}

export interface BackfillTableResult {
  total: number;
  byScope: ScopeCount;
}

export interface BackfillResult {
  dryRun: boolean;
  sessions: BackfillTableResult;
  facts: BackfillTableResult;
  exemplars: BackfillTableResult;
  signals: BackfillTableResult;
  workstreams: BackfillTableResult;
  skipped: { missingTranscript: number; malformed: number; noCwdFound: number };
}

function emptyTable(): BackfillTableResult {
  return { total: 0, byScope: {} };
}

export async function runScopeBackfill(opts: {
  db: Database.Database;
  apply: boolean;
  aliasMap: AliasMap;
}): Promise<BackfillResult> {
  const { db, apply, aliasMap } = opts;

  type SessionRow = { id: string; transcript_path: string };
  const sessionRows = db
    .prepare<[], SessionRow>(
      "SELECT id, transcript_path FROM sessions WHERE scope IS NULL AND transcript_path IS NOT NULL",
    )
    .all();

  const derivedScopes = new Map<string, string>();
  let missingCount = 0;
  let malformedCount = 0;
  let noCwdCount = 0;

  for (const row of sessionRows) {
    const { cwd, skipReason } = await readCwdFromTranscript(row.transcript_path);
    if (skipReason === "missing") {
      missingCount++;
      continue;
    }
    if (skipReason === "malformed") {
      malformedCount++;
      continue;
    }
    if (!cwd) {
      noCwdCount++;
      continue;
    }
    const scope = deriveScope(cwd, aliasMap);
    if (scope === null) continue;
    derivedScopes.set(row.id, scope);
  }

  const result: BackfillResult = {
    dryRun: !apply,
    sessions: emptyTable(),
    facts: emptyTable(),
    exemplars: emptyTable(),
    signals: emptyTable(),
    workstreams: emptyTable(),
    skipped: { missingTranscript: missingCount, malformed: malformedCount, noCwdFound: noCwdCount },
  };

  for (const scope of derivedScopes.values()) {
    result.sessions.total++;
    inc(result.sessions.byScope, scope);
  }

  const performUpdates = () => {
    const updateSession = db.prepare(
      "UPDATE sessions SET scope = ? WHERE id = ? AND scope IS NULL",
    );
    for (const [id, scope] of derivedScopes) {
      updateSession.run(scope, id);
    }

    type CountRow = { scope: string; n: number };

    const factRows = db
      .prepare<[], CountRow>(`
        SELECT s.scope, COUNT(f.id) AS n
        FROM facts f
        JOIN sessions s ON f.source_session_id = s.id
        WHERE f.scope IS NULL AND s.scope IS NOT NULL
        GROUP BY s.scope
      `)
      .all();
    for (const { scope, n } of factRows) {
      result.facts.total += n;
      inc(result.facts.byScope, scope);
    }
    db.prepare(`
      UPDATE facts
      SET scope = (SELECT s.scope FROM sessions s WHERE s.id = facts.source_session_id)
      WHERE scope IS NULL
        AND source_session_id IN (SELECT id FROM sessions WHERE scope IS NOT NULL)
    `).run();

    const exemplarRows = db
      .prepare<[], CountRow>(`
        SELECT s.scope, COUNT(e.id) AS n
        FROM code_exemplars e
        JOIN sessions s ON e.session_id = s.id
        WHERE e.scope IS NULL AND s.scope IS NOT NULL
        GROUP BY s.scope
      `)
      .all();
    for (const { scope, n } of exemplarRows) {
      result.exemplars.total += n;
      inc(result.exemplars.byScope, scope);
    }
    db.prepare(`
      UPDATE code_exemplars
      SET scope = (SELECT s.scope FROM sessions s WHERE s.id = code_exemplars.session_id)
      WHERE scope IS NULL
        AND session_id IN (SELECT id FROM sessions WHERE scope IS NOT NULL)
    `).run();

    const signalRows = db
      .prepare<[], CountRow>(`
        SELECT s.scope, COUNT(sig.id) AS n
        FROM signals sig
        JOIN sessions s ON sig.session_id = s.id
        WHERE sig.scope IS NULL AND s.scope IS NOT NULL AND s.scope != 'global'
        GROUP BY s.scope
      `)
      .all();
    for (const { scope, n } of signalRows) {
      result.signals.total += n;
      inc(result.signals.byScope, scope);
    }
    db.prepare(`
      UPDATE signals
      SET scope = (SELECT s.scope FROM sessions s WHERE s.id = signals.session_id)
      WHERE scope IS NULL
        AND session_id IS NOT NULL
        AND session_id IN (
          SELECT id FROM sessions WHERE scope IS NOT NULL AND scope != 'global'
        )
    `).run();

    type WsRow = { id: string };
    const pendingWorkstreams = db
      .prepare<[], WsRow>("SELECT id FROM workstreams WHERE scope IS NULL")
      .all();

    type MemberRow = { scope: string | null };
    const getMemberScopes = db.prepare<[string], MemberRow>(
      "SELECT scope FROM sessions WHERE workstream_id = ?",
    );
    const updateWs = db.prepare(
      "UPDATE workstreams SET scope = ? WHERE id = ? AND scope IS NULL",
    );

    for (const ws of pendingWorkstreams) {
      const members = getMemberScopes.all(ws.id);
      if (members.length === 0) continue;
      if (members.some((m) => m.scope === null)) continue;
      const unique = new Set(members.map((m) => m.scope as string));
      if (unique.size !== 1) continue;
      const wsScope = [...unique][0]!;
      result.workstreams.total++;
      inc(result.workstreams.byScope, wsScope);
      updateWs.run(wsScope, ws.id);
    }
  };

  if (apply) {
    db.transaction(performUpdates)();
  } else {
    db.exec("BEGIN");
    try {
      performUpdates();
    } finally {
      db.exec("ROLLBACK");
    }
  }

  return result;
}

export function formatBackfillResult(
  result: BackfillResult,
  write: (s: string) => void,
): void {
  const heading = result.dryRun
    ? "scope backfill (dry run -- no writes):"
    : "scope backfill applied:";
  write(`${heading}\n`);

  const rows: Array<[string, string, BackfillTableResult]> = [
    ["sessions", result.dryRun ? "would change" : "stamped", result.sessions],
    ["facts", result.dryRun ? "would cascade" : "cascaded", result.facts],
    ["exemplars", result.dryRun ? "would cascade" : "cascaded", result.exemplars],
    ["signals", result.dryRun ? "would cascade" : "cascaded", result.signals],
    ["workstreams", result.dryRun ? "would cascade" : "cascaded", result.workstreams],
  ];

  for (const [table, verb, data] of rows) {
    const entries = Object.entries(data.byScope);
    const breakdown =
      entries.length > 0
        ? `  [${entries.map(([s, c]) => `${s}: ${c}`).join(", ")}]`
        : "";
    write(`  ${table.padEnd(12)}${String(data.total).padStart(4)} ${verb}${breakdown}\n`);
  }

  const { missingTranscript, malformed, noCwdFound } = result.skipped;
  const skipTotal = missingTranscript + malformed + noCwdFound;
  if (skipTotal > 0) {
    write(
      `  skipped:     ${skipTotal}` +
        ` (missing transcript: ${missingTranscript}, malformed: ${malformed}, no cwd found: ${noCwdFound})\n`,
    );
  } else {
    write(`  skipped:        0\n`);
  }
}
