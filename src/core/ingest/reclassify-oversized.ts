/**
 * One-shot recovery: re-classify large sessions that never ingested (they
 * failed under an old num_ctx and are not retried because the scheduler only
 * reprocesses files that grow). Uses classifyAdaptive so oversized bodies get
 * full-coverage hierarchical extraction.
 */
import type { Database } from "better-sqlite3";
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
import { extractFacts } from "@core/facts/extract-facts.js";
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
  readonly log?: (msg: string) => void;
}

export interface ReclassifyOptions {
  readonly limit?: number;
  readonly dryRun?: boolean;
}

export interface ReclassifyResult {
  readonly attempted: number;
  readonly ingested: number;
  readonly skippedLowConfidence: number;
  readonly failed: number;
  readonly missingFile: number;
  readonly entities: number;
  readonly decisions: number;
  readonly facts: number;
}

export function selectOversizedFailures(
  db: Database,
  limit?: number,
): Array<{ adapter_name: string; source_path: string }> {
  const sql =
    "SELECT adapter_name, source_path FROM adapter_state " +
    "WHERE session_id IS NULL AND failure_count >= 1 ORDER BY file_size DESC" +
    (limit !== undefined ? ` LIMIT ${Math.floor(limit)}` : "");
  return db.prepare(sql).all() as Array<{ adapter_name: string; source_path: string }>;
}

export async function reclassifyOversized(
  deps: ReclassifyDeps,
  opts: ReclassifyOptions = {},
): Promise<ReclassifyResult> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const byName = new Map(deps.adapters.map((a) => [a.name, a]));
  const rows = selectOversizedFailures(deps.db, opts.limit);

  let ingested = 0;
  let skippedLowConfidence = 0;
  let failed = 0;
  let missingFile = 0;
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
      missingFile++;
      continue;
    }

    let classification;
    try {
      classification = await classifyAdaptive(chunk.text, deps.classifier);
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
      body: chunk.text.slice(0, BODY_CAP),
      status: "closed",
      transcriptKind: adapter.transcriptKind,
      transcriptPath: row.source_path,
      transcriptOffset: null,
      transcriptLength: chunk.text.length,
      entities: classification.entities,
      decisions: classification.decisions,
      openQuestions: classification.open,
    };

    const extracted = extractFacts(classification, chunk.id, chunk.startedAt);

    try {
      await deps.store.insertSession(record, deps.embedder, null, {
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

  return { attempted: rows.length, ingested, skippedLowConfidence, failed, missingFile, entities, decisions, facts };
}
