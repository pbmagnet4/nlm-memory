/**
 * NullCodeExemplarStore — no-op implementation of CodeExemplarStore.
 *
 * Used by PgStorage until a full PG exemplar adapter is built.
 * All writes succeed silently; reads return empty results.
 */

import type { CodeExemplarSearchFilter, CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput } from "@shared/types.js";

export class NullCodeExemplarStore implements CodeExemplarStore {
  async insert(_input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }> {
    return { id: "", skipped: true };
  }
  async insertMany(_inputs: ReadonlyArray<CodeExemplarInput>): Promise<number> { return 0; }
  async upsertEmbedding(_exemplarId: string, _vector: Float32Array): Promise<void> {}
  async searchByVector(_v: Float32Array, _f: CodeExemplarSearchFilter): Promise<ReadonlyArray<CodeExemplarHit>> { return []; }
  async getById(_id: string): Promise<CodeExemplar | null> { return null; }
  async applyBucketCap(_installScope: string, _maxPerBucket: number): Promise<number> { return 0; }
  async pruneReverted(_installScope: string): Promise<number> { return 0; }
  async pruneOlderThan(_olderThanTs: string): Promise<number> { return 0; }
}
