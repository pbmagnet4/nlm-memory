import type { MemoryProperty } from "@core/properties/model.js";
export interface PropertyBackfillRow { readonly factId?: string; readonly sessionId?: string; readonly slug: string | null; readonly source: string | null }
export interface PropertyStore {
  associateSession(tenantId: string, sessionId: string, slugs: readonly string[]): Promise<void>;
  list(tenantId: string): Promise<readonly MemoryProperty[]>;
  import(tenantId: string, input: unknown): Promise<void>;
  correctFact(tenantId: string, factId: string, slug: string | null): Promise<void>;
  backfill(tenantId: string, apply: boolean): Promise<readonly PropertyBackfillRow[]>;
  pendingCorrections(tenantId: string): Promise<readonly { sourceIdentity: string; assertionKey: string }[]>;
}
