import type { Workstream } from "@core/workstream/model.js";

export interface WorkstreamStore {
  create(input: { id: string; label: string }): Promise<Workstream>;
  getById(id: string): Promise<Workstream | null>;
  findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null>;
  listAll(): Promise<ReadonlyArray<Workstream>>;
  touchLastSession(id: string, atIso: string): Promise<void>;
  upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void>;
  entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>>;
  candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>>;
}
