import type { Workstream } from "@core/workstream/model.js";

/**
 * Tenancy (program spec §4, M2 plan Wave B4): every method takes `tenantId`
 * as its non-optional first parameter. `workstreams` and `workstream_entities`
 * are both STAMP tables. Reads/mutations never cross tenants — merge,
 * rebind, and candidatesByEntityOverlap all resolve and act within one
 * tenant only.
 */
export interface WorkstreamStore {
  create(tenantId: string, input: { id: string; label: string; scope: string | null }): Promise<Workstream>;
  getById(tenantId: string, id: string): Promise<Workstream | null>;
  findByNormalizedLabel(tenantId: string, normalizedLabel: string): Promise<Workstream | null>;
  listAll(tenantId: string): Promise<ReadonlyArray<Workstream>>;
  touchLastSession(tenantId: string, id: string, atIso: string): Promise<void>;
  setLabel(tenantId: string, id: string, label: string): Promise<void>;
  setStatus(tenantId: string, id: string, status: import("@core/workstream/model.js").WorkstreamStatus): Promise<void>;
  /** Supersede fromId into intoId: set merged_into + status="merged", union entities, clear from's entity rows. Both ids must resolve within tenantId. */
  merge(tenantId: string, fromId: string, intoId: string): Promise<void>;
  upsertEntities(tenantId: string, workstreamId: string, entities: ReadonlyArray<string>): Promise<void>;
  entitiesFor(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>>;
  candidatesByEntityOverlap(tenantId: string, entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>>;
}
