import type { Workstream } from "@core/workstream/model.js";

export interface WorkstreamStore {
  create(input: { id: string; label: string; scope: string | null }): Promise<Workstream>;
  getById(id: string): Promise<Workstream | null>;
  findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null>;
  listAll(): Promise<ReadonlyArray<Workstream>>;
  touchLastSession(id: string, atIso: string): Promise<void>;
  setLabel(id: string, label: string): Promise<void>;
  setStatus(id: string, status: import("@core/workstream/model.js").WorkstreamStatus): Promise<void>;
  /** Supersede fromId into intoId: set merged_into + status="merged", union entities, clear from's entity rows. */
  merge(fromId: string, intoId: string): Promise<void>;
  upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void>;
  entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>>;
  candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>>;
}
