/**
 * Exemplar extraction from a Signal.
 *
 * Two sourcing paths (plan section 2):
 * (a) git diff at the linked commit — language-agnostic, preferred for
 *     gate/test signals tied to a commit; uses git's hunk headers for
 *     free funcname capture.
 * (b) producer-supplied code in signal.detail.code — for pre-commit gates
 *     and eval harnesses where no commit exists yet.
 *
 * Returns null when neither path produces a valid chunk, so the caller can
 * skip without error.
 */

import { execFileSync } from "node:child_process";
import { codeHash, normalizeExemplar } from "./ingest-exemplar.js";
import { detectLang, extractAddedLines, parseFuncname, parseHunks, selectLargestHunk } from "./diff-parse.js";
import type { CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";
import type { Signal } from "@shared/types.js";

export interface ExtractOptions {
  readonly installScope: string;
  readonly repoPath?: string;
  readonly scope?: string | null;
}

export interface GitShaExtractParams {
  readonly repo: string;
  readonly sha: string;
  readonly installScope: string;
  readonly outcome: CodeExemplarOutcome;
  readonly model?: string;
  readonly signalId?: string | null;
  readonly sessionId?: string | null;
  readonly ts?: string;
  readonly repoPath?: string;
  readonly taskContext?: string;
  readonly scope?: string | null;
}

/**
 * Path (a): extract exemplar from a git commit's diff.
 * Returns null if the git command fails or no valid hunks are found.
 */
export function extractFromGitSha(params: GitShaExtractParams): CodeExemplarInput | null {
  const repoPath = params.repoPath ?? params.repo;
  let diff: string;
  try {
    diff = execFileSync(
      "git",
      ["show", "--unified=3", "--diff-filter=AM", params.sha],
      { cwd: repoPath, encoding: "utf8", timeout: 10_000 },
    );
  } catch {
    // Git show failed — exemplar extraction from this commit skipped.
    return null;
  }

  const hunks = parseHunks(diff);
  if (hunks.length === 0) return null;

  const best = selectLargestHunk(hunks);
  if (!best) return null;

  const code = extractAddedLines(best.body);
  const funcname = parseFuncname(best.hunkHeader);
  const taskContext = params.taskContext
    ?? (funcname ? `${funcname} (${best.file})` : `changes in ${best.file}`);

  try {
    return normalizeExemplar({
      installScope: params.installScope,
      signalId: params.signalId ?? null,
      sessionId: params.sessionId ?? null,
      repo: params.repo,
      model: params.model ?? "unknown",
      lang: detectLang(best.file),
      taskContext,
      code,
      outcome: params.outcome,
      gitSha: params.sha,
      survived: null,
      scope: params.scope ?? null,
      ...(params.ts ? { ts: params.ts } : {}),
    });
  } catch {
    // Normalization failed — exemplar from git hunk discarded.
    return null;
  }
}

/**
 * Path (b): extract exemplar from signal.detail.code (producer-supplied).
 * Returns null if detail.code is absent or doesn't pass size validation.
 */
export function extractFromDetail(signal: Signal, opts: ExtractOptions): CodeExemplarInput | null {
  const detail = signal.detail;
  if (!detail || typeof detail["code"] !== "string") return null;
  const code = detail["code"] as string;

  const taskContext =
    typeof detail["task"] === "string"
      ? (detail["task"] as string)
      : typeof signal.step === "string"
      ? signal.step
      : "agent-supplied code";

  const lang =
    typeof detail["lang"] === "string" ? (detail["lang"] as string) : null;

  try {
    return normalizeExemplar({
      installScope: opts.installScope,
      signalId: signal.id,
      sessionId: signal.sessionId,
      repo: signal.repo,
      model: signal.model,
      lang,
      taskContext,
      code,
      outcome: signal.outcome,
      gitSha: typeof detail["git_sha"] === "string" ? (detail["git_sha"] as string) : null,
      survived: null,
      scope: opts.scope ?? null,
      ts: signal.ts,
    });
  } catch {
    // Normalization failed — exemplar from signal detail discarded.
    return null;
  }
}

/**
 * Top-level: try path (a) first, fall back to path (b).
 * Inline with signal ingest; called after a signal is stored.
 */
export function extractExemplar(
  signal: Signal,
  opts: ExtractOptions & { repoBasePath?: string },
): CodeExemplarInput | null {
  // Path (a): git sha from detail, if present.
  const gitSha =
    signal.detail && typeof signal.detail["git_sha"] === "string"
      ? (signal.detail["git_sha"] as string)
      : null;
  if (gitSha) {
    const repoPath = opts.repoBasePath ? `${opts.repoBasePath}/${signal.repo}` : signal.repo;
    const fromGit = extractFromGitSha({
      repo: signal.repo,
      sha: gitSha,
      installScope: opts.installScope,
      outcome: signal.outcome,
      model: signal.model,
      signalId: signal.id,
      sessionId: signal.sessionId,
      ts: signal.ts,
      repoPath,
      scope: signal.scope,
    });
    if (fromGit) return fromGit;
  }

  // Path (b): producer-supplied code in detail.
  return extractFromDetail(signal, { ...opts, scope: signal.scope });
}
