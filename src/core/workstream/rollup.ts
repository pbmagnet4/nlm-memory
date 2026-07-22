// src/core/workstream/rollup.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { FactStore } from "@ports/fact-store.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { WorkstreamRollup } from "./model.js";
import { resolveWorkstreamId } from "./resolve.js";

export interface RollupDeps {
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "getById">;
  readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
  readonly facts: Pick<FactStore, "listBySessions">;
  readonly exemplars: Pick<CodeExemplarStore, "listBySessions">;
}

export async function rollupWorkstream(deps: RollupDeps, tenantId: string, workstreamId: string): Promise<WorkstreamRollup | null> {
  const all = await deps.workstreams.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const survivorId = resolveWorkstreamId(workstreamId, byId);
  const workstream = await deps.workstreams.getById(survivorId);
  if (!workstream) return null;

  const memberIds = all.filter((w) => resolveWorkstreamId(w.id, byId) === survivorId).map((w) => w.id);
  const sessionIds = await deps.sessions.listSessionIdsByWorkstreams(tenantId, memberIds);
  const [facts, exemplars] = await Promise.all([
    deps.facts.listBySessions(tenantId, sessionIds),
    deps.exemplars.listBySessions(sessionIds),
  ]);
  return { workstream, sessionIds, facts, exemplars };
}
