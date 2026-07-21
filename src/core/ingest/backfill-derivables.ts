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
 *
 * Task 5 addition: `--with-transcript-scan` optionally also re-scans each
 * candidate's transcript file for primary_model/total_tokens/skill via
 * scanTranscriptDerivables. Off by default — scanning streams every
 * candidate's transcript off disk and is far slower than the persona/parent
 * derivation above, which only touches already-loaded columns. When the
 * flag is set, candidacy widens beyond WHERE agent_persona IS NULL with an
 * OR arm keyed on the scan's own columns (claude-code-jsonl rows with a
 * transcript_path and all three scan columns still NULL) — otherwise a row
 * whose persona was stamped by an earlier flagless run would never be
 * scannable, leaving the flag shipped but effectively unwired for exactly
 * the rows Task 3 already processed. Rows selected only via that arm get a
 * scan-only write (persona/parent untouched); either way the scan columns
 * COALESCE-preserve, and a re-run reports updated=0 because a stamped scan
 * column excludes the row from the OR arm on the next pass.
 */

import type { Database } from "better-sqlite3";
import { deriveSubagentMeta } from "@core/adapters/claude-code.js";
import { scanTranscriptDerivables, type TranscriptDerivables } from "./transcript-derivables.js";

const BATCH_SIZE = 500;

const NULL_TRANSCRIPT_DERIVABLES: TranscriptDerivables = {
  primaryModel: null,
  totalTokens: null,
  skill: null,
};

interface CandidateRow {
  readonly id: string;
  readonly runtime: string;
  readonly runtime_session_id: string | null;
  readonly label: string;
  readonly agent_persona: string | null;
  readonly parent_session_id: string | null;
  readonly transcript_path: string | null;
  readonly transcript_kind: string | null;
}

export interface BackfillOptions {
  readonly dryRun?: boolean;
  /**
   * Also scan each candidate's transcript file for
   * primary_model/total_tokens/skill (#352 phase 2, Task 5). Off by
   * default: slower than the persona/parent derivation (streams every
   * candidate's transcript off disk).
   */
  readonly withTranscriptScan?: boolean;
}

export interface BackfillReport {
  /** All rows in the sessions table, stamped or not. */
  readonly total: number;
  /** Rows whose write would change something (or did, when not --dry-run). */
  readonly updated: number;
  /**
   * Rows not selected at all: agent_persona already stamped and (when
   * withTranscriptScan) not eligible for the scan arm either.
   */
  readonly skippedAlreadyStamped: number;
  /**
   * Selected rows whose derived values match what's already stored — persona
   * unrecoverable (NULL derives NULL), parent either already stamped by a
   * prior run or also underivable, and (when withTranscriptScan) the
   * transcript scan derived nothing either. Attempted, nothing to write.
   */
  readonly skippedNoop: number;
  /** Of the selected rows, how many derived a real parent link (subagent-shaped runtimeSessionId). */
  readonly subagentCandidates: number;
  /** Of the selected rows, how many derived a literal "unknown" parent placeholder. */
  readonly unknownParent: number;
  /** Rows whose transcript was scanned and derived at least one non-null
   *  field. Always 0 when withTranscriptScan is not set. */
  readonly transcriptScanned: number;
}

// Widened OR arm for --with-transcript-scan: rows already persona-stamped
// (e.g. by an earlier flagless Task 3 run) but never transcript-scanned.
// Scoped to claude-code-jsonl since scanTranscriptDerivables derives nothing
// for any other kind; requires ALL three scan columns NULL so any stamped
// scan column excludes the row on the next pass (re-run idempotency).
const SCAN_CANDIDATE_ARM =
  " OR (transcript_path IS NOT NULL AND transcript_kind = 'claude-code-jsonl'" +
  " AND primary_model IS NULL AND total_tokens IS NULL AND skill IS NULL)";

function selectCandidates(db: Database, withTranscriptScan: boolean): CandidateRow[] {
  return db
    .prepare<[], CandidateRow>(
      "SELECT id, runtime, runtime_session_id, label, agent_persona, parent_session_id, transcript_path, transcript_kind" +
      " FROM sessions WHERE agent_persona IS NULL" +
      (withTranscriptScan ? SCAN_CANDIDATE_ARM : ""),
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

export async function backfillDerivables(db: Database, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  const candidates = selectCandidates(db, Boolean(opts.withTranscriptScan));
  const skippedAlreadyStamped = total - candidates.length;

  let subagentCandidates = 0;
  let unknownParent = 0;
  let skippedNoop = 0;
  let transcriptScanned = 0;
  const toWrite: {
    id: string;
    // null meta = scan-only row (persona already stamped; selected via the
    // widened OR arm) — the write must not touch persona/parent.
    meta: { persona: string | null; parentSessionId: string | null } | null;
    transcript: TranscriptDerivables;
  }[] = [];

  for (const row of candidates) {
    const meta = row.agent_persona === null ? deriveMeta(row) : null;
    if (meta) {
      if (meta.parentSessionId !== null) subagentCandidates++;
      if (meta.parentSessionId === "unknown") unknownParent++;
    }

    let transcript = NULL_TRANSCRIPT_DERIVABLES;
    if (opts.withTranscriptScan && row.transcript_path) {
      transcript = await scanTranscriptDerivables(row.transcript_path, row.transcript_kind ?? "");
      if (transcript.primaryModel !== null || transcript.totalTokens !== null || transcript.skill !== null) {
        transcriptScanned++;
      }
    }

    // Persona-null rows: the write is a no-op exactly when the derived
    // persona is also NULL and the derived parent matches what a prior run
    // already stamped (or is equally NULL). Scan-only rows have nothing to
    // write for meta by definition.
    const metaIsNoop = meta === null || (meta.persona === null && meta.parentSessionId === row.parent_session_id);
    const transcriptIsNoop =
      transcript.primaryModel === null && transcript.totalTokens === null && transcript.skill === null;
    if (metaIsNoop && transcriptIsNoop) {
      skippedNoop++;
      continue;
    }
    toWrite.push({ id: row.id, meta, transcript });
  }

  if (opts.dryRun) {
    return { total, updated: toWrite.length, skippedAlreadyStamped, skippedNoop, subagentCandidates, unknownParent, transcriptScanned };
  }

  const metaAndScanStmt = db.prepare<[string | null, string | null, string | null, number | null, string | null, string], void>(
    `UPDATE sessions SET
       agent_persona = ?, parent_session_id = ?,
       primary_model = COALESCE(primary_model, ?),
       total_tokens = COALESCE(total_tokens, ?),
       skill = COALESCE(skill, ?)
     WHERE id = ? AND agent_persona IS NULL`,
  );
  const scanOnlyStmt = db.prepare<[string | null, number | null, string | null, string], void>(
    `UPDATE sessions SET
       primary_model = COALESCE(primary_model, ?),
       total_tokens = COALESCE(total_tokens, ?),
       skill = COALESCE(skill, ?)
     WHERE id = ?`,
  );

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = toWrite.slice(i, i + BATCH_SIZE);
    const runBatch = db.transaction((rows: typeof batch) => {
      for (const row of rows) {
        if (row.meta) {
          metaAndScanStmt.run(
            row.meta.persona,
            row.meta.parentSessionId,
            row.transcript.primaryModel,
            row.transcript.totalTokens,
            row.transcript.skill,
            row.id,
          );
        } else {
          scanOnlyStmt.run(
            row.transcript.primaryModel,
            row.transcript.totalTokens,
            row.transcript.skill,
            row.id,
          );
        }
      }
    });
    runBatch(batch);
  }

  return { total, updated: toWrite.length, skippedAlreadyStamped, skippedNoop, subagentCandidates, unknownParent, transcriptScanned };
}
