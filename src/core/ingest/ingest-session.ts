/**
 * ingestSession — push a single externally-supplied session through the
 * normal classifier → embedder → store pipeline.
 *
 * Shared by the webhook endpoint (POST /api/ingest) and anything else
 * that wants to push without going through a TranscriptAdapter. Mirrors
 * the inner loop of ScanScheduler.runOnce but accepts a pre-built chunk.
 */

import { createHash } from "node:crypto";
import { extractFacts } from "@core/facts/extract-facts.js";
import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { IngestRecord, SqliteSessionStore } from "@core/storage/sqlite-session-store.js";
import { PgSessionStore } from "@core/storage/pg-session-store.js";
import type { PgFactStore } from "@core/storage/pg-fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { Fact } from "@shared/types.js";

const BODY_CAP = 200_000;
const CONFIDENCE_FLOOR = 0.3;

export interface IngestInput {
  /** Optional — if omitted, derived from a hash of (runtime + startedAt + text). */
  readonly id?: string;
  readonly runtime: string;
  readonly runtimeSessionId?: string | null;
  readonly text: string;
  readonly startedAt?: string;
  readonly endedAt?: string | null;
  readonly transcriptPath?: string | null;
  /** Webhook id when the source is webhook-pushed; null for generic. */
  readonly sourceId?: number | null;
}

export interface IngestDeps {
  readonly classifier: LLMClient;
  readonly embedder: LLMClient;
  readonly store: SqliteSessionStore | PgSessionStore;
  readonly factStore?: SqliteFactStore | PgFactStore;
  /** Optional logger — defaults to console.error. */
  readonly log?: (msg: string) => void;
}

export interface IngestResult {
  readonly id: string;
  readonly status: "ingested" | "low_confidence" | "classifier_failed";
  readonly latencyMs: number;
  readonly confidence?: number;
  readonly error?: string;
}

export function deriveSessionId(runtime: string, startedAt: string, text: string): string {
  const hash = createHash("sha256")
    .update(runtime)
    .update("|")
    .update(startedAt)
    .update("|")
    .update(text.slice(0, 4_000))
    .digest("hex")
    .slice(0, 16);
  return `webhook_${hash}`;
}

export async function ingestSession(input: IngestInput, deps: IngestDeps): Promise<IngestResult> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const id = input.id ?? deriveSessionId(input.runtime, startedAt, input.text);
  const log = deps.log ?? ((m: string) => console.error(m));
  const t0 = Date.now();

  let classification;
  try {
    classification = await deps.classifier.classify(input.text);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`[ingest] classifier failed for ${id}: ${error}`);
    return { id, status: "classifier_failed", latencyMs: Date.now() - t0, error };
  }

  if (classification.confidence < CONFIDENCE_FLOOR) {
    return {
      id,
      status: "low_confidence",
      latencyMs: Date.now() - t0,
      confidence: classification.confidence,
    };
  }

  const record: IngestRecord = {
    id,
    runtime: input.runtime,
    runtimeSessionId: input.runtimeSessionId ?? null,
    startedAt,
    endedAt: input.endedAt ?? null,
    durationMin: null,
    label: classification.label,
    summary: classification.summary,
    body: input.text.slice(0, BODY_CAP),
    status: "closed",
    transcriptKind: "webhook",
    transcriptPath: input.transcriptPath ?? null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: classification.entities,
    decisions: classification.decisions,
    openQuestions: classification.open,
  };

  const facts: ReadonlyArray<Fact> = deps.factStore
    ? extractFacts(classification, id, startedAt)
    : [];

  // Store + factStore come from the same backend (see buildStack); the cast
  // is sound — TS can't correlate the two union members at one call site.
  if (deps.store instanceof PgSessionStore) {
    await deps.store.insertSession(record, deps.embedder, null,
      deps.factStore ? { factStore: deps.factStore as PgFactStore, facts } : null);
  } else {
    await deps.store.insertSession(record, deps.embedder, null,
      deps.factStore ? { factStore: deps.factStore as SqliteFactStore, facts } : null);
  }
  return { id, status: "ingested", latencyMs: Date.now() - t0, confidence: classification.confidence };
}
