/**
 * DreamSettingsStore — the dreaming lane's runtime settings persisted for the
 * whole daemon (T1729). One row, mirroring classifier_settings: the passes are
 * one process-global scheduler lane and POST /api/dreaming is a LOCAL-hosted
 * control plane, so there is no per-tenant switch to key a row on.
 *
 * The row holds the whole settings document as JSON — the store never merges
 * or interprets it. No row means "nothing stored": the NLM_DREAM_* env seed
 * wins. A stored document is validated by the settings module, not here.
 */

export interface DreamSettingsStore {
  /** The stored document (already parsed), or null when no row exists yet.
   *  A row whose JSON will not parse rejects — the caller falls back to env. */
  load(): Promise<unknown>;
  /** Replace the stored document wholesale. */
  save(document: unknown): Promise<void>;
}
