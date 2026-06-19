/**
 * Capture code exemplars from an ingested coding session.
 *
 * Detects the commit(s) the session produced, extracts each committed diff
 * deterministically (git show), and labels it with a task-context composed
 * from the classifier's summary + decisions — the "beneficial choice" the
 * code implemented. Outcome bootstraps to "pass" (committed = accepted);
 * LLM outcome-refinement is a later phase.
 *
 * Pure with respect to storage: returns CodeExemplarInput[] for the caller
 * (the scheduler) to insert + embed. Git failures yield fewer exemplars,
 * never wrong ones.
 */

import type { CodeExemplarInput } from "@shared/types.js";
import { detectCommitShas } from "./detect-commits.js";
import { extractFromGitSha } from "./extract-exemplar.js";

const TASK_CONTEXT_CAP = 280;

export interface SessionExemplarContext {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly text: string;
  readonly startedAt: string;
  readonly summary: string;
  readonly decisions: ReadonlyArray<string>;
  readonly installScope: string;
}

export function composeTaskContext(summary: string, decisions: ReadonlyArray<string>): string {
  const base = summary.trim();
  const decision = decisions[0]?.trim();
  const text = decision ? `${base} — ${decision}` : base;
  return text.slice(0, TASK_CONTEXT_CAP);
}

export function captureExemplarsFromSession(ctx: SessionExemplarContext): CodeExemplarInput[] {
  if (!ctx.projectDir) return [];
  const taskContext = composeTaskContext(ctx.summary, ctx.decisions);
  const out: CodeExemplarInput[] = [];
  for (const sha of detectCommitShas(ctx.text)) {
    const exemplar = extractFromGitSha({
      repo: ctx.projectDir,
      sha,
      installScope: ctx.installScope,
      outcome: "pass",
      sessionId: ctx.sessionId,
      ts: ctx.startedAt,
      taskContext,
    });
    if (exemplar) out.push(exemplar);
  }
  return out;
}
