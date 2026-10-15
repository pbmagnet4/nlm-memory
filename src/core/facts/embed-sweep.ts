/**
 * Daemon fact-embedding sweep (T732 / E1). Re-embeds recall-eligible facts that
 * lack a vector: those recorded in fact_embed_pending whose backoff elapsed,
 * plus unrecorded drops. Idempotent (discovery is by absence) and low priority:
 * sequential, small batch, and every embed holds a slot of the shared in-flight
 * cap, so it never takes more than its share from recall queries. A saturated
 * cap stops the batch and counts as shed, not as a failure.
 */

import type { SqliteFactStore } from "@core/storage/sqlite-fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { tryAcquire, release } from "@core/health/embed-inflight.js";
import { composeFactEmbedText } from "./embed-backfill.js";

export interface FactSweepReport {
  readonly attempted: number;
  readonly repaired: number;
  readonly failed: number;
  readonly shed: boolean;
}

export interface FactSweepOptions {
  readonly tenantId: string;
  readonly store: SqliteFactStore;
  readonly embedder: LLMClient;
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export async function sweepFactEmbeddings(opts: FactSweepOptions): Promise<FactSweepReport> {
  const now = opts.now ?? (() => new Date());
  const due = opts.store.listFactsDueForEmbedding(opts.tenantId, opts.batchSize ?? 25, now());
  let attempted = 0;
  let repaired = 0;
  let failed = 0;
  let shed = false;
  for (const fact of due) {
    const text = composeFactEmbedText(fact.subject, fact.predicate, fact.value);
    if (!text) continue;
    if (!tryAcquire()) {
      shed = true;
      break;
    }
    attempted += 1;
    try {
      const { vector } = await opts.embedder.embed(text, "document");
      await opts.store.upsertEmbedding(opts.tenantId, fact.id, vector);
      repaired += 1;
    } catch (err) {
      failed += 1;
      opts.store.markEmbedPending(fact.id, String(err), now());
    } finally {
      release();
    }
  }
  return { attempted, repaired, failed, shed };
}
