// src/core/workstream/bind.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { BindingSource } from "./model.js";
import { makeWorkstreamId } from "./model.js";
import { decideWorkstreamByName } from "./name-match.js";
import { scopeStampEnabled } from "@core/scope/stamp-flag.js";

export const NAMING_CONTENT_CHARS = 8000;

export interface BindDeps {
  readonly namer: Pick<LLMClient, "nameWorkstream">;
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "create" | "upsertEntities" | "touchLastSession">;
  readonly sessions: Pick<SessionStore, "setWorkstreamBinding">;
  readonly aliasToLabel: ReadonlyMap<string, string>;
  readonly log?: (msg: string) => void;
  readonly source?: BindingSource;
}

export interface BindInput {
  readonly sessionId: string;
  readonly label: string;
  readonly summary: string;
  readonly body?: string;
  readonly entities: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly scope: string | null;
}

export interface BindResult {
  readonly workstreamId: string;
}

function scopeMatches(wsScope: string | null, sessionScope: string | null): boolean {
  return wsScope === sessionScope;
}

async function applyBinding(deps: BindDeps, input: BindInput, workstreamId: string): Promise<BindResult> {
  await deps.sessions.setWorkstreamBinding(input.sessionId, workstreamId, deps.source ?? "classifier", null);
  await deps.workstreams.upsertEntities(workstreamId, input.entities);
  await deps.workstreams.touchLastSession(workstreamId, input.startedAt);
  return { workstreamId };
}

export async function bindSessionToWorkstream(deps: BindDeps, input: BindInput): Promise<BindResult | null> {
  try {
    const all = await deps.workstreams.listAll();
    const content = `${input.label}\n${(input.body || input.summary).slice(0, NAMING_CONTENT_CHARS)}`;

    if (scopeStampEnabled()) {
      const scoped = all.filter((w) => scopeMatches(w.scope, input.scope));
      const named = await deps.namer.nameWorkstream(content, scoped.map((w) => ({ label: w.label })));
      const decision = decideWorkstreamByName(named, scoped, deps.aliasToLabel);

      if (decision.kind === "bind") {
        return applyBinding(deps, input, decision.workstreamId);
      }

      if (named && named.trim()) {
        const ws = await deps.workstreams.create({ id: makeWorkstreamId(), label: named.trim(), scope: input.scope });
        return applyBinding(deps, input, ws.id);
      }
      return null;
    }

    const named = await deps.namer.nameWorkstream(content, all.map((w) => ({ label: w.label })));
    const decision = decideWorkstreamByName(named, all, deps.aliasToLabel);
    if (decision.kind === "abstain") return null;
    return applyBinding(deps, input, decision.workstreamId);
  } catch (e) {
    deps.log?.(`[workstream] bind failed for ${input.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
