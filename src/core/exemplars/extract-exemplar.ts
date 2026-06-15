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
import type { CodeExemplarInput } from "@shared/types.js";
import type { Signal } from "@shared/types.js";

export interface ExtractOptions {
  readonly installScope: string;
  readonly repoPath?: string;
}

/** Extract a git hunk header funcname: `@@ ... @@ funcname` */
function parseFuncname(hunkHeader: string): string | null {
  const m = hunkHeader.match(/@@ [^@]+ @@ (.+)/);
  return m?.[1]?.trim() ?? null;
}

/** Detect likely language from file extension. */
function detectLang(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "ts", js: "js", jsx: "js", mjs: "js",
    py: "py", go: "go", rb: "rb", rs: "rs", java: "java",
    c: "c", cpp: "cpp", cs: "cs", swift: "swift", kt: "kt",
    sh: "sh", bash: "sh", zsh: "sh",
  };
  return map[ext] ?? null;
}

/**
 * Parse a unified diff into individual hunks. Returns (file, hunkHeader, body) triples.
 */
function parseHunks(diff: string): Array<{ file: string; hunkHeader: string; body: string }> {
  const result: Array<{ file: string; hunkHeader: string; body: string }> = [];
  let currentFile = "";
  let currentHeader = "";
  let bodyLines: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      if (currentHeader && bodyLines.length > 0) {
        result.push({ file: currentFile, hunkHeader: currentHeader, body: bodyLines.join("\n") });
      }
      currentHeader = line;
      bodyLines = [];
    } else if (currentHeader && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      bodyLines.push(line);
    }
  }
  if (currentHeader && bodyLines.length > 0) {
    result.push({ file: currentFile, hunkHeader: currentHeader, body: bodyLines.join("\n") });
  }
  return result;
}

/**
 * Extract the added/changed lines from a hunk body (strip context and removed lines).
 */
function extractAddedLines(hunkBody: string): string {
  return hunkBody
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

/**
 * Path (a): extract exemplar from a git commit's diff.
 * Returns null if the git command fails or no valid hunks are found.
 */
export function extractFromGitSha(
  signal: Signal,
  gitSha: string,
  opts: ExtractOptions,
): CodeExemplarInput | null {
  const repoPath = opts.repoPath ?? signal.repo;
  let diff: string;
  try {
    diff = execFileSync(
      "git",
      ["show", "--unified=3", "--diff-filter=AM", gitSha],
      { cwd: repoPath, encoding: "utf8", timeout: 10_000 },
    );
  } catch {
    return null;
  }

  const hunks = parseHunks(diff);
  if (hunks.length === 0) return null;

  // Pick the largest hunk by added-line count (most representative).
  let best: { file: string; hunkHeader: string; body: string } | undefined;
  let bestCount = 0;
  for (const h of hunks) {
    const added = extractAddedLines(h.body);
    const count = added.split("\n").filter((l) => l.trim()).length;
    if (count > bestCount) { bestCount = count; best = h; }
  }
  if (!best) return null;

  const code = extractAddedLines(best.body);
  const funcname = parseFuncname(best.hunkHeader);
  const taskContext = funcname
    ? `${funcname} (${best.file})`
    : `changes in ${best.file}`;

  try {
    return normalizeExemplar({
      installScope: opts.installScope,
      signalId: signal.id,
      sessionId: signal.sessionId,
      repo: signal.repo,
      model: signal.model,
      lang: detectLang(best.file),
      taskContext,
      code,
      outcome: signal.outcome,
      gitSha,
      survived: null,
      ts: signal.ts,
    });
  } catch {
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
      ts: signal.ts,
    });
  } catch {
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
    const fromGit = extractFromGitSha(signal, gitSha, { installScope: opts.installScope, repoPath });
    if (fromGit) return fromGit;
  }

  // Path (b): producer-supplied code in detail.
  return extractFromDetail(signal, opts);
}
