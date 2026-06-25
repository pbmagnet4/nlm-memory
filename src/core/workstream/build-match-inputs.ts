// src/core/workstream/build-match-inputs.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { MatchInputs, MatchThresholds, MatchWeights, WorkstreamCandidate } from "./model.js";
import { resolveWorkstreamId } from "./resolve.js";

const NEIGHBOR_K = 10;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface BuildMatchInputsDeps {
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "candidatesByEntityOverlap" | "entitiesFor">;
  readonly sessions: Pick<SessionStore, "semanticSearch" | "getWorkstreamIds">;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
}
export interface BuildMatchInputsInput {
  readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>;
}

export async function buildMatchInputs(deps: BuildMatchInputsDeps, input: BuildMatchInputsInput): Promise<MatchInputs> {
  const { vector } = await deps.embedder.embed(`${input.label}\n${input.summary}`, "query");
  const neighbors = (await deps.sessions.semanticSearch(vector, NEIGHBOR_K)).filter((n) => n.sessionId !== input.sessionId);

  const all = await deps.workstreams.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const wsOfNeighbor = await deps.sessions.getWorkstreamIds(neighbors.map((n) => n.sessionId));

  const neighborScores = new Map<string, number>();
  for (const n of neighbors) {
    const wsRaw = wsOfNeighbor.get(n.sessionId);
    if (!wsRaw) continue;
    const wsId = resolveWorkstreamId(wsRaw, byId);
    const sim = clamp01(1 - (n.distance * n.distance) / 2);
    neighborScores.set(wsId, Math.max(neighborScores.get(wsId) ?? 0, sim));
  }

  const entityCands = await deps.workstreams.candidatesByEntityOverlap(input.entities, NEIGHBOR_K);
  const candIds = new Set<string>([...neighborScores.keys(), ...entityCands.map((c) => c.workstreamId)]);
  const entMap = await deps.workstreams.entitiesFor([...candIds]);
  const candidates: WorkstreamCandidate[] = [...candIds].map((id) => ({ workstreamId: id, entities: entMap.get(id) ?? [] }));

  return { sessionEntities: input.entities, neighborScores, candidates, thresholds: deps.thresholds, weights: deps.weights };
}
