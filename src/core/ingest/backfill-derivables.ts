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
 * derivation above, which only touches already-loaded columns. Reuses the
 * same candidate set (WHERE agent_persona IS NULL) rather than a second
 * query; a row with a non-null transcript_path gets scanned regardless of
 * whether its persona/parent derivation was itself a no-op, so a
 * persona-unrecoverable row can still pick up model/token/skill data.
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
  /** Rows already stamped (agent_persona NOT NULL) before this run. */
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

function selectCandidates(db: Database): CandidateRow[] {
  return db
    .prepare<[], CandidateRow>(
      "SELECT id, runtime, runtime_session_id, label, parent_session_id, transcript_path, transcript_kind FROM sessions WHERE agent_persona IS NULL",
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
  const candidates = selectCandidates(db);
  const skippedAlreadyStamped = total - candidates.length;

  let subagentCandidates = 0;
  let unknownParent = 0;
  let skippedNoop = 0;
  let transcriptScanned = 0;
  const toWrite: {
    id: string;
    meta: { persona: string | null; parentSessionId: string | null };
    transcript: TranscriptDerivables;
  }[] = [];

  for (const row of candidates) {
    const meta = deriveMeta(row);
    if (meta.parentSessionId !== null) subagentCandidates++;
    if (meta.parentSessionId === "unknown") unknownParent++;

    let transcript = NULL_TRANSCRIPT_DERIVABLES;
    if (opts.withTranscriptScan && row.transcript_path) {
      transcript = await scanTranscriptDerivables(row.transcript_path, row.transcript_kind ?? "");
      if (transcript.primaryModel !== null || transcript.totalTokens !== null || transcript.skill !== null) {
        transcriptScanned++;
      }
    }

    // Stored persona is NULL by selection, so the write is a no-op exactly
    // when the derived persona is also NULL, the derived parent matches what
    // a prior run already stamped (or is equally NULL), and the transcript
    // scan (if run) derived nothing either.
    const metaIsNoop = meta.persona === null && meta.parentSessionId === row.parent_session_id;
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

  const updateStmt = db.prepare<[string | null, string | null, string | null, number | null, string | null, string], void>(
    `UPDATE sessions SET
       agent_persona = ?, parent_session_id = ?,
       primary_model = COALESCE(primary_model, ?),
       total_tokens = COALESCE(total_tokens, ?),
       skill = COALESCE(skill, ?)
     WHERE id = ? AND agent_persona IS NULL`,
  );

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = toWrite.slice(i, i + BATCH_SIZE);
    const runBatch = db.transaction((rows: typeof batch) => {
      for (const row of rows) {
        updateStmt.run(
          row.meta.persona,
          row.meta.parentSessionId,
          row.transcript.primaryModel,
          row.transcript.totalTokens,
          row.transcript.skill,
          row.id,
        );
      }
    });
    runBatch(batch);
  }

  return { total, updated: toWrite.length, skippedAlreadyStamped, skippedNoop, subagentCandidates, unknownParent, transcriptScanned };
}
