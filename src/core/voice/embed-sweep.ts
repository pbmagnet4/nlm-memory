/**
 * Voice embed retry sweep (T2438 piece C, design §A invariant 3).
 *
 * Insert is best-effort at the endpoint, so a row can land without a vector
 * when the embedder is down or the shared in-flight cap sheds it.
 * `missingEmbeddings` lists exactly those rows and this sweep re-embeds a small
 * batch of them, the sibling of the session-chunk sweep (chunk-retry.ts) and
 * under the same shared embed cap. With no vector a sample is still recallable
 * (the recall lane falls back to newest-first), which is why a whole failed
 * batch is one log line and not an outage.
 */

import type { LLMClient } from "@ports/llm-client.js";
import type { WritingSampleMissing } from "@ports/writing-sample-store.js";
import { release, tryAcquire } from "@core/health/embed-inflight.js";

/** Prose embeddings are slower than code ones; eight per tick is a good floor. */
export const VOICE_EMBED_SWEEP_BATCH = 8;

/** The store side of the sweep: the two WritingSampleStore methods it uses. */
export interface VoiceEmbedSweepStore {
  missingEmbeddings(tenantId: string, limit: number): Promise<ReadonlyArray<WritingSampleMissing>>;
  upsertEmbedding(tenantId: string, id: string, vector: Float32Array): Promise<void>;
}

export interface VoiceEmbedSweepReport {
  readonly attempted: number;
  readonly repaired: number;
  readonly failed: number;
  readonly shed: boolean;
}

export interface VoiceEmbedSweepOptions {
  readonly tenantId: string;
  readonly store: VoiceEmbedSweepStore;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly batchSize?: number;
}

export async function sweepVoiceEmbeddings(
  opts: VoiceEmbedSweepOptions,
): Promise<VoiceEmbedSweepReport> {
  const missing = await opts.store.missingEmbeddings(opts.tenantId, opts.batchSize ?? VOICE_EMBED_SWEEP_BATCH);
  let attempted = 0;
  let repaired = 0;
  let failed = 0;
  let shed = false;

  for (const { id, text } of missing) {
    if (!tryAcquire()) {
      shed = true;
      break;
    }
    attempted += 1;
    try {
      const { vector } = await opts.embedder.embed(text, "document");
      await opts.store.upsertEmbedding(opts.tenantId, id, vector);
      repaired += 1;
    } catch {
      failed += 1;
    } finally {
      release();
    }
  }

  return { attempted, repaired, failed, shed };
}
