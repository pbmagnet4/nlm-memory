// src/core/workstream/bind.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { MatchThresholds, MatchWeights } from "./model.js";
import { makeWorkstreamId, normalizeLabel } from "./model.js";
import { matchWorkstream } from "./match.js";
import { buildMatchInputs } from "./build-match-inputs.js";

export interface BindDeps {
  readonly workstreams: WorkstreamStore;
  readonly sessions: Pick<SessionStore, "setWorkstreamBinding" | "semanticSearch" | "getWorkstreamIds">;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
  readonly pickAmbiguous: (input: { sessionLabel: string; sessionSummary: string; candidates: ReadonlyArray<{ workstreamId: string; label: string; entities: ReadonlyArray<string> }> }) => Promise<string | null>;
  readonly log?: (msg: string) => void;
}
export interface BindInput { readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>; readonly startedAt: string; }
export interface BindResult { readonly workstreamId: string; readonly created: boolean; readonly confidence: number | null; }

export async function bindSessionToWorkstream(deps: BindDeps, input: BindInput): Promise<BindResult | null> {
  try {
    const inputs = await buildMatchInputs(deps, {
      sessionId: input.sessionId, label: input.label, summary: input.summary, entities: input.entities,
    });
    const decision = matchWorkstream(inputs);
    const candidateEntities = new Map(inputs.candidates.map((c) => [c.workstreamId, c.entities]));

    let workstreamId: string;
    let created = false;
    let confidence: number | null = null;

    if (decision.kind === "bind") {
      workstreamId = decision.workstreamId;
      confidence = decision.confidence;
    } else if (decision.kind === "ambiguous") {
      const enriched = await Promise.all(decision.candidates.map(async (c) => {
        const w = await deps.workstreams.getById(c.workstreamId);
        return { workstreamId: c.workstreamId, label: w?.label ?? c.workstreamId, entities: candidateEntities.get(c.workstreamId) ?? [], score: c.score };
      }));
      const chosen = await deps.pickAmbiguous({ sessionLabel: input.label, sessionSummary: input.summary, candidates: enriched });
      if (chosen) {
        workstreamId = chosen;
        confidence = enriched.find((e) => e.workstreamId === chosen)?.score ?? null;
      } else {
        ({ workstreamId, created } = await createOrDedup(deps, input.label));
      }
    } else {
      ({ workstreamId, created } = await createOrDedup(deps, input.label));
    }

    await deps.sessions.setWorkstreamBinding(input.sessionId, workstreamId, "classifier", confidence);
    await deps.workstreams.upsertEntities(workstreamId, input.entities);
    await deps.workstreams.touchLastSession(workstreamId, input.startedAt);
    return { workstreamId, created, confidence };
  } catch (e) {
    deps.log?.(`[workstream] bind failed for ${input.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function createOrDedup(deps: BindDeps, label: string): Promise<{ workstreamId: string; created: boolean }> {
  const existing = await deps.workstreams.findByNormalizedLabel(normalizeLabel(label));
  if (existing) return { workstreamId: existing.id, created: false };
  const ws = await deps.workstreams.create({ id: makeWorkstreamId(), label: label.trim() || "untitled" });
  return { workstreamId: ws.id, created: true };
}
