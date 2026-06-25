// src/core/workstream/backfill-workstreams.ts

export interface BackfillSession { readonly sessionId: string; readonly content: string; }

export interface BackfillDeps {
  readonly listSessions: () => Promise<ReadonlyArray<BackfillSession>>;
  readonly nameSession: (sessionId: string, content: string) => Promise<string | null>;
  readonly decide: (named: string | null) => { kind: "bind"; workstreamId: string } | { kind: "abstain" };
  readonly setBinding: (sessionId: string, workstreamId: string) => Promise<void>;
  readonly log?: (msg: string) => void;
}

export interface BackfillResult { readonly considered: number; readonly bound: number; readonly skipped: number; }

export async function backfillWorkstreams(deps: BackfillDeps): Promise<BackfillResult> {
  const sessions = await deps.listSessions();
  let bound = 0; let skipped = 0;
  for (const s of sessions) {
    const decision = deps.decide(await deps.nameSession(s.sessionId, s.content));
    if (decision.kind === "bind") {
      await deps.setBinding(s.sessionId, decision.workstreamId);
      bound++;
      deps.log?.(`[backfill] ${s.sessionId} -> ${decision.workstreamId}`);
    } else {
      skipped++;
    }
  }
  return { considered: sessions.length, bound, skipped };
}
