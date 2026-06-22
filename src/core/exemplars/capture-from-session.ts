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

import { basename } from "node:path";
import type { CodeExemplarInput } from "@shared/types.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import { detectCommitShas } from "./detect-commits.js";
import { extractFromGitSha } from "./extract-exemplar.js";
import { composeEmbedText } from "./embed-text.js";

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
  const text = decision ? `${base} - ${decision}` : base;
  return text.slice(0, TASK_CONTEXT_CAP);
}

export function captureExemplarsFromSession(ctx: SessionExemplarContext): CodeExemplarInput[] {
  if (!ctx.projectDir) return [];
  const taskContext = composeTaskContext(ctx.summary, ctx.decisions);
  const out: CodeExemplarInput[] = [];
  for (const sha of detectCommitShas(ctx.text)) {
    const exemplar = extractFromGitSha({
      repo: basename(ctx.projectDir),
      repoPath: ctx.projectDir,
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

export interface DrainExemplarDeps {
  readonly exemplarStore: CodeExemplarStore;
  readonly codeEmbedder?: CodeEmbedder | null;
  readonly logger?: (msg: string) => void;
}

export async function drainSessionExemplars(
  ctx: SessionExemplarContext,
  deps: DrainExemplarDeps,
): Promise<number> {
  if (process.env["NLM_CODE_EXEMPLARS_ENABLED"] !== "1") return 0;
  let count = 0;
  try {
    for (const input of captureExemplarsFromSession(ctx)) {
      const { id, skipped } = await deps.exemplarStore.insert(input);
      if (skipped) continue;
      count += 1;
      if (deps.codeEmbedder) {
        const embedder = deps.codeEmbedder;
        const store = deps.exemplarStore;
        void embedder
          .embed(composeEmbedText(input.taskContext, input.code), "document")
          .then((r) => store.upsertEmbedding(id, r.vector))
          .catch(() => { /* degraded; exemplar stored without a vector */ });
      }
    }
  } catch (e) {
    deps.logger?.(`exemplar capture failed for ${ctx.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return count;
}
