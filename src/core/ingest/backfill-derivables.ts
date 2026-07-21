/**
 * backfill-derivables — one-time retroactive stamp of agent_persona +
 * parent_session_id (#352 phase 2) onto sessions ingested before the
 * scheduler started stamping them at classify time (see
 * src/core/scheduler/scheduler.ts, commit 34968a8).
 *
 * Mirrors the live stamp site exactly so backfilled rows match
 * freshly-ingested ones: claude-code rows go through deriveSubagentMeta
 * (reversing the `<parent>/agent-<id>` runtimeSessionId + `[subagent <slug>]`
 * label encoding); every other runtime has no subagent concept, so persona
 * is just the runtime name and parent is null.
 *
 * Idempotent: selection is WHERE agent_persona IS NULL, so a re-run only
 * touches rows a prior run (or live ingest) hasn't stamped yet.
 *
 * Known data quirk (Task 2 review): some subagent transcripts encode a
 * literal `unknown` parent (`unknown/agent-<id>`), which derives
 * parentSessionId = "unknown" — a non-joining placeholder, not a real
 * session id. The backfill still writes it, for consistency with live
 * stamping, but counts it separately (`unknownParent`) so operators can see
 * how much of the corpus has an unresolvable parent link.
 *
 * Persona is frequently unrecoverable for pre-existing subagent rows: the
 * live stamp site derives persona from the transient pre-classification
 * chunk.label (which carries the `[subagent <slug>]` prefix), but the
 * `label` column this backfill reads is the classifier's generated title —
 * that prefix is already gone by the time a row lands in `sessions`. In
 * practice this means most historical subagent rows get parent_session_id
 * populated but agent_persona stays NULL. Only genuinely new ingests (which
 * derive from the live chunk before classification overwrites it) get both.
 * Such rows stay selectable (agent_persona IS NULL) forever, so the run
 * compares derived values against stored ones and counts a row `updated`
 * only when the write would change something; a re-run over a fully
 * backfilled corpus reports updated=0 with the unrecoverable rows under
 * `skippedNoop`.
 */

import type { Database } from "better-sqlite3";
import { deriveSubagentMeta } from "@core/adapters/claude-code.js";

const BATCH_SIZE = 500;

interface CandidateRow {
  readonly id: string;
  readonly runtime: string;
  readonly runtime_session_id: string | null;
  readonly label: string;
  readonly parent_session_id: string | null;
}

export interface BackfillOptions {
  readonly dryRun?: boolean;
}

export interface BackfillReport {
  /** All rows in the sessions table, stamped or not. */
  readonly total: number;
  /** Rows whose write would change something (or did, when not --dry-run). */
  readonly updated: number;
  /** Rows already stamped (agent_persona NOT NULL) before this run. */
  readonly skippedAlreadyStamped: number;
  /**
   * Selected rows whose derived values match what's already stored — persona
   * unrecoverable (NULL derives NULL) and parent either already stamped by a
   * prior run or also underivable. Attempted, nothing to write.
   */
  readonly skippedNoop: number;
  /** Of the selected rows, how many derived a real parent link (subagent-shaped runtimeSessionId). */
  readonly subagentCandidates: number;
  /** Of the selected rows, how many derived a literal "unknown" parent placeholder. */
  readonly unknownParent: number;
}

function selectCandidates(db: Database): CandidateRow[] {
  return db
    .prepare<[], CandidateRow>(
      "SELECT id, runtime, runtime_session_id, label, parent_session_id FROM sessions WHERE agent_persona IS NULL",
    )
    .all();
}

// The sessions.runtime column stores the adapter's versioned runtime string
// (e.g. "claude-code/1.0", "hermes/1.0" — see each adapter's runtimeVersion
// field), but the live stamp site in scheduler.ts branches on the bare
// adapter name ("claude-code", "hermes", ...). Strip the version suffix so
// the backfill branches identically to a fresh ingest.
function bareRuntimeName(runtime: string): string {
  const slash = runtime.indexOf("/");
  return slash === -1 ? runtime : runtime.slice(0, slash);
}

function deriveMeta(row: CandidateRow): { persona: string | null; parentSessionId: string | null } {
  const runtimeName = bareRuntimeName(row.runtime);
  if (runtimeName === "claude-code") {
    return deriveSubagentMeta(row.runtime_session_id ?? "", row.label);
  }
  return { persona: runtimeName, parentSessionId: null };
}

export function backfillDerivables(db: Database, opts: BackfillOptions = {}): BackfillReport {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  const candidates = selectCandidates(db);
  const skippedAlreadyStamped = total - candidates.length;

  let subagentCandidates = 0;
  let unknownParent = 0;
  let skippedNoop = 0;
  const toWrite: { id: string; meta: { persona: string | null; parentSessionId: string | null } }[] = [];
  for (const row of candidates) {
    const meta = deriveMeta(row);
    if (meta.parentSessionId !== null) subagentCandidates++;
    if (meta.parentSessionId === "unknown") unknownParent++;
    // Stored persona is NULL by selection, so the write is a no-op exactly
    // when the derived persona is also NULL and the derived parent matches
    // what a prior run already stamped (or is equally NULL).
    if (meta.persona === null && meta.parentSessionId === row.parent_session_id) {
      skippedNoop++;
      continue;
    }
    toWrite.push({ id: row.id, meta });
  }

  if (opts.dryRun) {
    return { total, updated: toWrite.length, skippedAlreadyStamped, skippedNoop, subagentCandidates, unknownParent };
  }

  const updateStmt = db.prepare<[string | null, string | null, string], void>(
    "UPDATE sessions SET agent_persona = ?, parent_session_id = ? WHERE id = ? AND agent_persona IS NULL",
  );

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = toWrite.slice(i, i + BATCH_SIZE);
    const runBatch = db.transaction((rows: typeof batch) => {
      for (const row of rows) {
        updateStmt.run(row.meta.persona, row.meta.parentSessionId, row.id);
      }
    });
    runBatch(batch);
  }

  return { total, updated: toWrite.length, skippedAlreadyStamped, skippedNoop, subagentCandidates, unknownParent };
}
