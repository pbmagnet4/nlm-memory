// src/core/workstream/bind.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { decideWorkstreamByName } from "./name-match.js";

export const NAMING_CONTENT_CHARS = 8000;

export interface BindDeps {
  readonly namer: Pick<LLMClient, "nameWorkstream">;
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "upsertEntities" | "touchLastSession">;
  readonly sessions: Pick<SessionStore, "setWorkstreamBinding">;
  readonly aliasToLabel: ReadonlyMap<string, string>;
  readonly log?: (msg: string) => void;
}

export interface BindInput {
  readonly sessionId: string;
  readonly label: string;
  readonly summary: string;
  readonly body?: string;
  readonly entities: ReadonlyArray<string>;
  readonly startedAt: string;
}

export interface BindResult {
  readonly workstreamId: string;
  readonly created: boolean;
  readonly confidence: number | null;
}

export async function bindSessionToWorkstream(deps: BindDeps, input: BindInput): Promise<BindResult | null> {
  try {
    const ws = await deps.workstreams.listAll();
    const hints = ws.map((w) => ({
      label: w.label,
      aliases: [] as string[],
    }));
    const content = `${input.label}\n${(input.body ?? input.summary).slice(0, NAMING_CONTENT_CHARS)}`;
    const named = await deps.namer.nameWorkstream(content, hints);
    const decision = decideWorkstreamByName(named, ws, deps.aliasToLabel);

    if (decision.kind === "abstain") return null;

    const { workstreamId } = decision;
    await deps.sessions.setWorkstreamBinding(input.sessionId, workstreamId, "classifier", null);
    await deps.workstreams.upsertEntities(workstreamId, input.entities);
    await deps.workstreams.touchLastSession(workstreamId, input.startedAt);
    return { workstreamId, created: false, confidence: null };
  } catch (e) {
    deps.log?.(`[workstream] bind failed for ${input.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
