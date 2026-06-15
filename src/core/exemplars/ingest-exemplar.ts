/**
 * Boundary validation + normalization for inbound code exemplars.
 *
 * Parallel to ingest-signal.ts: validates at the boundary (fail loud),
 * soft-defaults optional fields. The id is deterministic so re-ingesting
 * the same chunk is a no-op at the store layer (INSERT OR IGNORE).
 *
 * Gated by NLM_CODE_EXEMPLARS_ENABLED. Callers must check the flag.
 */

import { createHash } from "node:crypto";
import type { CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";

const OUTCOMES: ReadonlySet<string> = new Set(["pass", "fail", "fix", "exhausted"]);

const MIN_MEANINGFUL_LINES = 2;
const MAX_LINES = 200;

/**
 * sha256 of the code after whitespace normalization.
 * Normalization: trim trailing whitespace per line + collapse blank runs.
 */
export function codeHash(code: string): string {
  const normalized = code
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
    .join("\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Count non-blank, non-brace-only lines. */
function meaningfulLineCount(code: string): number {
  return code.split("\n").filter((l) => {
    const t = l.trim();
    return t.length > 0 && t !== "{" && t !== "}" && t !== "}" + ";" && t !== "};";
  }).length;
}

export interface RawExemplarPayload {
  readonly installScope: string;
  readonly signalId?: string | null;
  readonly sessionId?: string | null;
  readonly repo: string;
  readonly model: string;
  readonly lang?: string | null;
  readonly taskContext: string;
  readonly code: string;
  readonly outcome: string;
  readonly gitSha?: string | null;
  readonly survived?: 0 | 1 | null;
  readonly ts?: string;
}

export function normalizeExemplar(
  raw: RawExemplarPayload,
  now: () => string = () => new Date().toISOString(),
): CodeExemplarInput {
  const outcome = raw.outcome;
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`exemplar.outcome must be one of pass|fail|fix|exhausted (got ${String(outcome)})`);
  }
  if (!raw.repo || typeof raw.repo !== "string") {
    throw new Error("exemplar.repo is required");
  }
  if (!raw.taskContext || typeof raw.taskContext !== "string") {
    throw new Error("exemplar.taskContext is required");
  }
  if (!raw.code || typeof raw.code !== "string") {
    throw new Error("exemplar.code is required");
  }

  const meaningful = meaningfulLineCount(raw.code);
  if (meaningful < MIN_MEANINGFUL_LINES) {
    throw new Error(
      `exemplar.code too small (${meaningful} meaningful lines, minimum ${MIN_MEANINGFUL_LINES})`,
    );
  }
  if (meaningful > MAX_LINES) {
    throw new Error(
      `exemplar.code too large (${meaningful} meaningful lines, maximum ${MAX_LINES}); split into smaller hunks`,
    );
  }

  return {
    installScope: raw.installScope,
    signalId: raw.signalId ?? null,
    sessionId: raw.sessionId ?? null,
    repo: raw.repo,
    model: raw.model || "unknown",
    lang: raw.lang ?? null,
    taskContext: raw.taskContext,
    code: raw.code,
    codeHash: codeHash(raw.code),
    outcome: outcome as CodeExemplarOutcome,
    gitSha: raw.gitSha ?? null,
    survived: raw.survived ?? null,
    ts: raw.ts ?? now(),
  };
}
