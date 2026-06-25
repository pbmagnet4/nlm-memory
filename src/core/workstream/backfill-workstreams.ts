// src/core/workstream/backfill-workstreams.ts
import { matchWorkstream } from "./match.js";
import type { MatchInputs } from "./model.js";

export interface BuildMatchInputsInput {
  readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>;
}
export interface BackfillWorkstreamsDeps {
  readonly buildInputs: (input: BuildMatchInputsInput) => Promise<MatchInputs>;
  readonly setBinding: (sessionId: string, workstreamId: string, confidence: number | null) => Promise<void>;
  readonly listSessions: () => Promise<ReadonlyArray<BuildMatchInputsInput>>;
  readonly log?: (msg: string) => void;
}
export interface BackfillResult { readonly considered: number; readonly bound: number; readonly skipped: number; }

export async function backfillWorkstreams(deps: BackfillWorkstreamsDeps): Promise<BackfillResult> {
  const sessions = await deps.listSessions();
  let bound = 0; let skipped = 0;
  for (const s of sessions) {
    const decision = matchWorkstream(await deps.buildInputs(s));
    if (decision.kind === "bind") {
      await deps.setBinding(s.sessionId, decision.workstreamId, decision.confidence);
      bound++;
      deps.log?.(`[backfill] ${s.sessionId} -> ${decision.workstreamId} (${decision.confidence?.toFixed(3)})`);
    } else {
      skipped++;   // ambiguous or create: leave NULL, forward binding handles it (never create in backfill)
    }
  }
  return { considered: sessions.length, bound, skipped };
}
