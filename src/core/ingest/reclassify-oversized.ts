/**
 * One-shot recovery: re-classify large sessions that never ingested (they
 * failed under an old num_ctx and are not retried because the scheduler only
 * reprocesses files that grow). Uses classifyAdaptive so oversized bodies get
 * full-coverage hierarchical extraction.
 *
 * The same loop serves `nlm reingest`: a different selector (every source of
 * one adapter) plus `onlyChanged`, which re-ingests only sources whose freshly
 * parsed body differs from the stored session, so re-runs are idempotent.
 */
import type { Database } from "better-sqlite3";
import { bodyVersion, persistedText } from "@core/context/source-version.js";
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
import { extractFacts } from "@core/facts/extract-facts.js";
import { deriveScope } from "@core/scope/derive-scope.js";
import { loadAliasMap } from "@core/scope/alias-map.js";
import { scopeStampEnabled } from "@core/scope/stamp-flag.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { SessionChunk, TranscriptAdapter } from "@ports/transcript-adapter.js";

const BODY_CAP = 200_000;
const CONFIDENCE_FLOOR = 0.3;

export interface ReclassifyDeps {
  readonly db: Database;
  readonly store: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly embedder: LLMClient;
  readonly classifier: LLMClient;
  readonly adapters: ReadonlyArray<TranscriptAdapter>;
  /** Provider and model name of the active classifier, for provenance stamping. */
  readonly classifierDescriptor?: { readonly provider: string; readonly model: string };
  readonly log?: (msg: string) => void;
}

export type SourceRow = { adapter_name: string; source_path: string };

export interface ReclassifyOptions {
  readonly limit?: number;
  readonly dryRun?: boolean;
  /** Which adapter_state rows to visit; defaults to the oversized-failure rows. */
  readonly select?: (db: Database, limit?: number) => SourceRow[];
  /** Skip sources whose parsed body equals the stored session body (or that parse to nothing). With dryRun, count instead of classifying. */
  readonly onlyChanged?: boolean;
  /** Per-call classifier timeout, as the daemon applies it. */
  readonly classifyTimeoutMs?: number;
}

export interface ReclassifyResult {
  readonly attempted: number;
  readonly ingested: number;
  readonly skippedLowConfidence: number;
  readonly failed: number;
  readonly missingFile: number;
  readonly unchanged: number;
  readonly wouldChange: number;
  readonly entities: number;
  readonly decisions: number;
  readonly facts: number;
}

export function selectOversizedFailures(db: Database, limit?: number): SourceRow[] {
  const sql =
    "SELECT adapter_name, source_path FROM adapter_state " +
    "WHERE session_id IS NULL AND failure_count >= 1 ORDER BY file_size DESC" +
    (limit !== undefined ? ` LIMIT ${Math.floor(limit)}` : "");
  return db.prepare(sql).all() as SourceRow[];
}

/** Every recorded source of one adapter, including those recorded as empty. */
export function selectAdapterSources(adapterName: string): (db: Database, limit?: number) => SourceRow[] {
  return (db, limit) =>
    db
      .prepare(
        "SELECT adapter_name, source_path FROM adapter_state WHERE adapter_name = ? ORDER BY source_path" +
          (limit !== undefined ? ` LIMIT ${Math.floor(limit)}` : ""),
      )
      .all(adapterName) as SourceRow[];
}

function storedBodyVersion(db: Database, sessionId: string): string | null {
  const row = db.prepare("SELECT body_version FROM sessions WHERE id = ?").get(sessionId) as
    | { body_version: string | null }
    | undefined;
  return row?.body_version ?? null;
}

export async function reclassifyOversized(
  deps: ReclassifyDeps,
  tenantId: string,
  opts: ReclassifyOptions = {},
): Promise<ReclassifyResult> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const byName = new Map(deps.adapters.map((a) => [a.name, a]));
  const rows = (opts.select ?? selectOversizedFailures)(deps.db, opts.limit);

  let ingested = 0;
  let skippedLowConfidence = 0;
  let failed = 0;
  let missingFile = 0;
  let unchanged = 0;
  let wouldChange = 0;
  let entities = 0;
  let decisions = 0;
  let facts = 0;

  for (const row of rows) {
    const adapter = byName.get(row.adapter_name);
    if (!adapter) {
      failed++;
      log(`[reclassify] no adapter for ${row.adapter_name}`);
      continue;
    }

    let chunk: SessionChunk | null;
    try {
      chunk = await adapter.parseSession(row.source_path);
    } catch (e) {
      missingFile++;
      log(`[reclassify] parse failed ${row.source_path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!chunk) {
      if (opts.onlyChanged) unchanged++;
      else missingFile++;
      continue;
    }

    const body = chunk.text.slice(0, BODY_CAP);
    if (opts.onlyChanged) {
      if (storedBodyVersion(deps.db, chunk.id) === bodyVersion(persistedText(body))) {
        unchanged++;
        continue;
      }
      if (opts.dryRun) {
        wouldChange++;
        continue;
      }
    }

    let classification;
    try {
      classification = await classifyAdaptive(
        chunk.text,
        deps.classifier,
        opts.classifyTimeoutMs !== undefined ? { perCallTimeoutMs: opts.classifyTimeoutMs } : undefined,
      );
    } catch (e) {
      failed++;
      log(`[reclassify] classify failed ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (opts.dryRun) {
      // dry-run classifies and counts candidates but performs NO writes —
      // including not resetting failure_count on low-confidence rows.
      continue;
    }

    if (classification.confidence < CONFIDENCE_FLOOR) {
      skippedLowConfidence++;
      deps.db
        .prepare("UPDATE adapter_state SET failure_count = 0 WHERE adapter_name = ? AND source_path = ?")
        .run(row.adapter_name, row.source_path);
      continue;
    }

    const record: IngestRecord = {
      id: chunk.id,
      runtime: chunk.runtime,
      runtimeSessionId: chunk.runtimeSessionId,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      durationMin: chunk.durationMin,
      label: classification.label,
      summary: classification.summary,
      body,
      status: "closed",
      transcriptKind: adapter.transcriptKind,
      transcriptPath: row.source_path,
      transcriptOffset: null,
      transcriptLength: chunk.text.length,
      entities: classification.entities,
      decisions: classification.decisions,
      openQuestions: classification.open,
      scope: scopeStampEnabled() && chunk.projectDir
        ? deriveScope(chunk.projectDir, loadAliasMap())
        : null,
      ...(deps.classifierDescriptor !== undefined
        ? { classifier: { ...deps.classifierDescriptor, confidence: classification.confidence } }
        : {}),
    };

    const extracted = extractFacts(classification, chunk.id, chunk.startedAt, { sourceBody: record.body ?? "" });

    try {
      await deps.store.insertSession(tenantId, record, deps.embedder, null, {
        factStore: deps.factStore,
        facts: extracted,
      });
      deps.db
        .prepare(
          "UPDATE adapter_state SET session_id = ?, last_offset = file_size, failure_count = 0 " +
          "WHERE adapter_name = ? AND source_path = ?",
        )
        .run(chunk.id, row.adapter_name, row.source_path);
      ingested++;
      entities += classification.entities.length;
      decisions += classification.decisions.length;
      facts += extracted.length;
    } catch (e) {
      failed++;
      log(`[reclassify] ingest failed ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { attempted: rows.length, ingested, skippedLowConfidence, failed, missingFile, unchanged, wouldChange, entities, decisions, facts };
}
