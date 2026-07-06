/**
 * Code-signal producer (#330): turns a coding commit into a deterministically
 * labeled, PATH-(b) code signal payload.
 *
 * The daemon's /api/signal handler runs extractExemplar, which prefers PATH (a)
 * (`git show` at detail.git_sha) when git_sha is present — that path couples the
 * daemon to the repo filesystem and breaks on a client install or a logical repo
 * name. This producer therefore emits PATH (b): it ships the changed code in
 * detail.code itself and records the sha under detail.commit (for provenance),
 * deliberately NOT under detail.git_sha, so path (a) is never triggered.
 *
 * repo is always a LOGICAL name (the override or the repoPath basename), never
 * an absolute filesystem path.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import {
  detectLang,
  extractAddedLines,
  parseFuncname,
  parseHunks,
  selectLargestHunk,
} from "../exemplars/diff-parse.js";
import type { SignalKind, SignalOutcome } from "@shared/types.js";

export interface BuildCodeSignalArgs {
  readonly repoPath: string;
  readonly sha: string;
  readonly testExit: number;
  readonly task?: string;
  readonly model?: string;
  readonly repo?: string;
  /** Unified diff to parse instead of shelling out — for unit tests. */
  readonly diff?: string;
  /** Clock injection for deterministic tests. */
  readonly ts?: () => string;
}

export interface CodeSignalDetail {
  readonly code: string;
  readonly lang: string | null;
  readonly task: string;
  readonly commit: string;
  readonly test_exit: number;
}

export interface CodeSignalPayload {
  readonly v: 1;
  readonly kind: SignalKind;
  readonly outcome: SignalOutcome;
  readonly producer: "code-commit";
  readonly model: string;
  readonly repo: string;
  readonly repo_path: string;
  readonly step: null;
  readonly detail: CodeSignalDetail;
  readonly session: null;
  readonly ts: string;
}

/** One-line success summary for the CLI: outcome + the accepted signal id. */
export function formatCodeSignalResult(outcome: SignalOutcome, signalId: string): string {
  return `code-signal: accepted outcome=${outcome} signal id=${signalId}`;
}

function gitShow(repoPath: string, sha: string): string {
  return execFileSync(
    "git",
    ["show", "--unified=3", "--diff-filter=AM", sha],
    { cwd: repoPath, encoding: "utf8", timeout: 10_000 },
  );
}

export function buildCodeSignalPayload(args: BuildCodeSignalArgs): CodeSignalPayload {
  const diff = args.diff ?? gitShow(args.repoPath, args.sha);
  const hunks = parseHunks(diff);
  const best = selectLargestHunk(hunks);

  const code = best ? extractAddedLines(best.body) : "";
  const lang = best ? detectLang(best.file) : null;
  const funcname = best ? parseFuncname(best.hunkHeader) : null;
  const task =
    args.task ??
    (best
      ? funcname
        ? `${funcname} (${best.file})`
        : `changes in ${best.file}`
      : "code commit");

  const outcome: SignalOutcome = args.testExit === 0 ? "pass" : "fail";
  const isoNow = (args.ts ?? (() => new Date().toISOString()))();

  return {
    v: 1,
    kind: "test",
    outcome,
    producer: "code-commit",
    model: args.model ?? "unknown",
    repo: args.repo ?? basename(args.repoPath),
    repo_path: args.repoPath,
    step: null,
    detail: { code, lang, task, commit: args.sha, test_exit: args.testExit },
    session: null,
    ts: isoNow,
  };
}
