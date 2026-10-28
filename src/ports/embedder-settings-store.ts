/**
 * EmbedderSettingsStore — daemon-wide persisted embedder settings, one row per
 * lane. `null` means "not set": the effective value falls back to env, then
 * the built-in default. The API key is stored but only ever read back by the
 * daemon itself to build a client; HTTP never returns it.
 */

import type { EmbeddingLane } from "@core/embedding/embedding-config.js";

export interface StoredEmbedderLane {
  readonly provider: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
}

/** A key left undefined is untouched; `null` clears the stored value. */
export type EmbedderLaneUpdate = Partial<StoredEmbedderLane>;

export interface EmbedderSettingsStore {
  get(lane: EmbeddingLane): Promise<StoredEmbedderLane>;
  update(lane: EmbeddingLane, patch: EmbedderLaneUpdate): Promise<StoredEmbedderLane>;
}

export const NO_STORED_EMBEDDER: StoredEmbedderLane = { provider: null, baseUrl: null, model: null, apiKey: null };

export function applyEmbedderUpdate(current: StoredEmbedderLane, patch: EmbedderLaneUpdate): StoredEmbedderLane {
  return {
    provider: patch.provider === undefined ? current.provider : patch.provider,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
    model: patch.model === undefined ? current.model : patch.model,
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey,
  };
}
