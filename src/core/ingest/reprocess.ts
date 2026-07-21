/**
 * reprocess: retroactive re-classification of prior sessions under a
 * stronger configured lane.
 *
 * Selection: sessions with a non-empty body whose classifier_model is NULL,
 * differs from the current lane model, or (when --min-confidence is given)
 * whose stored confidence falls below the threshold even for the same model.
 *
 * Per session: classifyAdaptive on the stored body, then a full insertSession
 * upsert (refreshes chunks + facts). A below-floor classification updates the
 * session row (label, summary, markers, provenance) but preserves prior facts
 * and their embeddings unchanged. It is counted in belowFloorOverwrites.
 * Workstream binding (workstream_id) is NOT touched by the upsert.
 *
 * Resumable via a JSON state file (default ~/.nlm/reprocess.state). A lane
 * change (different provider or model) invalidates the done-set.
 *
 * SQLite only. Pg variant deferred; file task against nlm#TODO in report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Database } from "better-sqlite3";
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
import { extractFacts } from "@core/facts/extract-facts.js";
import type { EmbeddingConfigStore } from "@core/embedding/embedding-config.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { SessionStatus } from "@shared/types.js";

const DEFAULT_STATE_PATH = join(homedir(), ".nlm", "reprocess.state");
const SAVE_EVERY = 25;
const CONFIDENCE_FLOOR = 0.4;

export interface ReprocessDeps {
  readonly db: Database;
  readonly store: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly embedder: LLMClient;
  readonly classifier: LLMClient;
  readonly classifierDescriptor: { readonly provider: string; readonly model: string };
  readonly embeddingConfig?: EmbeddingConfigStore;
  readonly embedderDescriptor?: { readonly provider: string; readonly model: string };
  readonly log?: (msg: string) => void;
}

export interface ReprocessOptions {
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly minConfidence?: number;
  readonly onlyNull?: boolean;
  readonly excludeModels?: string[];
  readonly statePath?: string;
  readonly classifyTimeoutMs?: number;
  readonly verbose?: boolean;
  readonly forceEmbed?: boolean;
  readonly onProgress?: (i: number, n: number, sid: string, status: string) => void;
}

export interface CohortGroup {
  readonly classifierProvider: string | null;
  readonly classifierModel: string | null;
  readonly confidenceBand: string;
  readonly count: number;
}

export interface ReprocessReport {
  readonly totalEligible: number;
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skippedAlreadyDone: number;
  readonly limitSkipped: number;
  readonly belowFloorOverwrites: number;
  readonly meanConfidenceOld: number | null;
  readonly meanConfidenceNew: number | null;
  readonly cohort?: ReadonlyArray<CohortGroup>;
  readonly stateNote?: string;
}

interface LaneIdentity {
  readonly provider: string;
  readonly model: string;
}

interface ReprocessSessionRow {
  readonly id: string;
  readonly runtime: string;
  readonly runtime_session_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly duration_min: number | null;
  readonly label: string;
  readonly summary: string;
  readonly status: string;
  readonly transcript_kind: string | null;
  readonly transcript_path: string | null;
  readonly transcript_offset: number | null;
  readonly transcript_length: number | null;
  readonly classifier_provider: string | null;
  readonly classifier_model: string | null;
  readonly classifier_confidence: number | null;
}

function confidenceBand(conf: number | null): string {
  if (conf === null) return "null";
  if (conf < 0.4) return "<0.4";
  if (conf < 0.6) return "0.4-0.6";
  if (conf < 0.8) return "0.6-0.8";
  return ">=0.8";
}

function loadState(path: string, lane: LaneIdentity): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      done?: string[];
      lane?: { provider: string; model: string };
    };
    if (raw.lane?.provider === lane.provider && raw.lane?.model === lane.model) {
      return new Set(raw.done ?? []);
    }
    return new Set();
  } catch {
    // Malformed state file: restart reprocessing from scratch.
    return new Set();
  }
}

function saveState(path: string, done: Set<string>, lane: LaneIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ done: [...done].sort(), lane }));
}

export function selectReprocessCandidates(
  db: Database,
  model: string,
  minConfidence?: number,
  opts?: { onlyNull?: boolean; excludeModels?: string[] },
): ReprocessSessionRow[] {
  const params: (string | number)[] = [];

  let classifierClause: string;
  if (opts?.onlyNull) {
    classifierClause = "classifier_model IS NULL";
  } else if (minConfidence !== undefined) {
    classifierClause = "(classifier_model IS NULL OR classifier_model != ? OR classifier_confidence < ?)";
    params.push(model, minConfidence);
  } else {
    classifierClause = "(classifier_model IS NULL OR classifier_model != ?)";
    params.push(model);
  }

  const excludeModels = opts?.excludeModels ?? [];
  let excludeClause = "";
  if (excludeModels.length > 0) {
    const placeholders = excludeModels.map(() => "?").join(", ");
    excludeClause = ` AND (classifier_model IS NULL OR classifier_model NOT IN (${placeholders}))`;
    params.push(...excludeModels);
  }

  const sql =
    "SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min, " +
    "label, summary, status, transcript_kind, transcript_path, " +
    "transcript_offset, transcript_length, " +
    "classifier_provider, classifier_model, classifier_confidence " +
    "FROM sessions " +
    "WHERE body IS NOT NULL AND length(body) > 0 " +
    "AND " +
    classifierClause +
    excludeClause +
    " " +
    "ORDER BY started_at DESC";

  return db.prepare<(string | number)[], ReprocessSessionRow>(sql).all(...params);
}

export async function reprocess(
  deps: ReprocessDeps,
  opts: ReprocessOptions = {},
): Promise<ReprocessReport> {
  const { db, store, factStore, embedder, classifier, classifierDescriptor } = deps;
  const log = deps.log ?? ((m: string) => console.error(m));
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const lane: LaneIdentity = {
    provider: classifierDescriptor.provider,
    model: classifierDescriptor.model,
  };

  const allCandidates = selectReprocessCandidates(db, classifierDescriptor.model, opts.minConfidence, {
    ...(opts.onlyNull ? { onlyNull: true } : {}),
    ...(opts.excludeModels ? { excludeModels: opts.excludeModels } : {}),
  });

  if (opts.dryRun) {
    const groupMap = new Map<string, CohortGroup>();
    for (const row of allCandidates) {
      const key = `${row.classifier_provider ?? ""}\u0000${row.classifier_model ?? ""}\u0000${confidenceBand(row.classifier_confidence)}`;
      const existing = groupMap.get(key);
      if (existing) {
        groupMap.set(key, { ...existing, count: existing.count + 1 });
      } else {
        groupMap.set(key, {
          classifierProvider: row.classifier_provider,
          classifierModel: row.classifier_model,
          confidenceBand: confidenceBand(row.classifier_confidence),
          count: 1,
        });
      }
    }
    const cohort = [...groupMap.values()].sort((a, b) => b.count - a.count);

    let stateNote: string | undefined;
    if (existsSync(statePath)) {
      const n = loadState(statePath, lane).size;
      stateNote = `state file present, ${n} sessions already done, real run will skip them`;
    }

    return {
      totalEligible: allCandidates.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skippedAlreadyDone: 0,
      limitSkipped: 0,
      belowFloorOverwrites: 0,
      meanConfidenceOld: null,
      meanConfidenceNew: null,
      cohort,
      ...(stateNote !== undefined ? { stateNote } : {}),
    };
  }

  if (deps.embeddingConfig && deps.embedderDescriptor) {
    const stored = deps.embeddingConfig.getLane("prose");
    if (stored) {
      let dim: number | null = null;
      try {
        const result = await deps.embedder.embed("nlm probe", "query");
        dim = result.vector.length;
      } catch {
        // probe failure: pre-tracking tolerance, proceed
      }
      if (dim !== null) {
        const mismatch =
          stored.provider !== deps.embedderDescriptor.provider ||
          stored.model !== deps.embedderDescriptor.model ||
          stored.dim !== dim;
        if (mismatch && !opts.forceEmbed) {
          const msg =
            `reprocess: prose embedding lane mismatch: stored ${stored.provider}/${stored.model}@${stored.dim}` +
            ` vs runtime ${deps.embedderDescriptor.provider}/${deps.embedderDescriptor.model}@${dim}.` +
            ` Re-embedding under a mismatched lane writes mixed vectors. Run nlm embed-backfill first,` +
            ` or pass --force-embed to override.`;
          log(msg);
          throw new Error(msg);
        }
      }
    }
  }

  const bodyStmt = db.prepare<[string], { body: string | null }>(
    "SELECT body FROM sessions WHERE id = ?",
  );

  const done = loadState(statePath, lane);

  const skippedByState = allCandidates.filter((r) => done.has(r.id)).length;
  const candidates = allCandidates.filter((r) => !done.has(r.id));
  const work = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;
  const total = work.length;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let belowFloorOverwrites = 0;
  let sumConfidenceOld = 0;
  let countOld = 0;
  let sumConfidenceNew = 0;
  let countNew = 0;

  for (let i = 0; i < work.length; i++) {
    const row = work[i]!;
    const sid = row.id;
    const idx = i + 1;

    const bodyRow = bodyStmt.get(sid);
    if (!bodyRow?.body) {
      failed++;
      processed++;
      log(`[reprocess] empty body ${sid}: skipping`);
      opts.onProgress?.(idx, total, sid, "empty_body");
      continue;
    }
    const body = bodyRow.body;

    let classification;
    try {
      classification = await classifyAdaptive(body, classifier, {
        ...(opts.classifyTimeoutMs ? { perCallTimeoutMs: opts.classifyTimeoutMs } : {}),
      });
    } catch (e) {
      failed++;
      processed++;
      log(`[reprocess] classify failed ${sid}: ${e instanceof Error ? e.message : String(e)}`);
      opts.onProgress?.(idx, total, sid, "classify_failed");
      continue;
    }

    if (row.classifier_confidence !== null) {
      sumConfidenceOld += row.classifier_confidence;
      countOld++;
    }
    sumConfidenceNew += classification.confidence;
    countNew++;

    const belowFloor = classification.confidence < CONFIDENCE_FLOOR;
    if (belowFloor) {
      belowFloorOverwrites++;
      if (opts.verbose) {
        log(
          `[reprocess] below-floor ${sid}: old=${row.classifier_confidence ?? "null"} new=${classification.confidence}`,
        );
      }
    } else if (opts.verbose) {
      log(
        `[reprocess] ${sid}: old=${row.classifier_confidence ?? "null"} new=${classification.confidence}`,
      );
    }

    const record: IngestRecord = {
      id: sid,
      runtime: row.runtime,
      runtimeSessionId: row.runtime_session_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMin: row.duration_min,
      label: classification.label,
      summary: classification.summary,
      body,
      status: row.status as SessionStatus,
      transcriptKind: row.transcript_kind,
      transcriptPath: row.transcript_path,
      transcriptOffset: row.transcript_offset,
      transcriptLength: row.transcript_length,
      entities: classification.entities,
      decisions: classification.decisions,
      openQuestions: classification.open,
      // Reprocess rebuilds from the stored row, which carries no project
      // directory evidence; the scope backfill command re-derives from the
      // transcript, so a NULL here is recoverable.
      scope: null,
      classifier: { ...classifierDescriptor, confidence: classification.confidence },
    };

    try {
      const factSinkArg = belowFloor
        ? null
        : { factStore, facts: extractFacts(classification, sid, row.started_at) };
      await store.insertSession(record, embedder, null, factSinkArg);
      done.add(sid);
      succeeded++;
      processed++;
      opts.onProgress?.(idx, total, sid, "ok");
      if (succeeded % SAVE_EVERY === 0) saveState(statePath, done, lane);
    } catch (e) {
      failed++;
      processed++;
      log(`[reprocess] ingest failed ${sid}: ${e instanceof Error ? e.message : String(e)}`);
      opts.onProgress?.(idx, total, sid, "ingest_failed");
    }
  }

  saveState(statePath, done, lane);

  const limitSkipped = opts.limit !== undefined ? candidates.length - work.length : 0;

  return {
    totalEligible: allCandidates.length,
    processed,
    succeeded,
    failed,
    skippedAlreadyDone: skippedByState,
    limitSkipped,
    belowFloorOverwrites,
    meanConfidenceOld: countOld > 0 ? sumConfidenceOld / countOld : null,
    meanConfidenceNew: countNew > 0 ? sumConfidenceNew / countNew : null,
  };
}
