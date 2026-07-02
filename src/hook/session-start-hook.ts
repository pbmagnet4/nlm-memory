/**
 * Claude Code SessionStart hook entrypoint for NLM recall.
 *
 * Fires before any prompt in a new session (including cron-fired and background
 * agents that never trigger UserPromptSubmit). Surfaces relevant prior context
 * proactively so cold-start agents aren't recall-blind.
 *
 * Query is derived from working_directory + project_name since no user prompt
 * exists yet — intentionally weaker than prompt-recall, best-effort only.
 *
 * Mirrors prompt-recall-hook.ts shape exactly: same pointer-block format, same
 * memo writes, same NLM_HOOK_MODE semantics.
 */

import { pathToFileURL } from "node:url";
import { appendHookLog } from "@core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { formatPointerBlock } from "@core/hook/pointer-block.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { parseScoreFloor, parseRelativeFloor } from "./score-floor.js";
import { recallOverHttp } from "./recall-over-http.js";
import { readStdin, hookModeFromEnv, fetchWithTimeout } from "./hook-helpers.js";

// This hook recalls in hybrid mode, whose matchScore is normalized to 0..1
// (mergeHybrid in recall-service.ts), so the default absolute floor is 0.
// NLM_RECALL_SCORE_FLOOR is shared with the keyword-mode prompt hook; the
// calibrated keyword floor (2.0, raw BM25) would deny-all here on the 0..1
// scale, so it is opt-in only. parseScoreFloor guards a bad env value.
const SCORE_THRESHOLD = parseScoreFloor(process.env["NLM_RECALL_SCORE_FLOOR"]);
// The relative floor IS scale-invariant (ratio to the fire median), so it
// applies cleanly to this hybrid path too — parity with the per-message hook.
const RELATIVE_FLOOR = parseRelativeFloor(process.env["NLM_RECALL_REL_FLOOR"], 0.9);
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const RECALL_TIMEOUT_MS = 2000;

export type HookMode = "shadow" | "live";

export interface SessionStartInput {
  readonly conversationId: string;
  readonly query: string;
}

export interface RunSessionStartDeps {
  readonly mode: HookMode;
  readonly recall: (query: string, conversationId?: string) => Promise<ReadonlyArray<RecallHitInput>>;
}

/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(
  input: SessionStartInput,
  deps: RunSessionStartDeps,
): Promise<string> {
  let hits: ReadonlyArray<RecallHitInput> = [];
  try {
    hits = await deps.recall(input.query, input.conversationId);
  } catch {
    hits = [];
  }

  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    relativeFloor: RELATIVE_FLOOR,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP,
  });
  const block = formatPointerBlock(selected);
  const estTokens = Math.ceil(block.length / 4);

  appendHookLog({
    ts: new Date().toISOString(),
    conversationId: input.conversationId,
    promptPreview: input.query,
    gate: "evaluate",
    hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
    wouldInject: selected.map((h) => h.id),
    estTokens,
    mode: deps.mode,
  });

  if (deps.mode === "live" && selected.length > 0) {
    recordSurfaced(input.conversationId, selected.map((h) => h.id));
    return block;
  }
  return "";
}

/** Join the failure-mode block (if any) above the session-recall block. */
export function composeSessionStartOutput(failureModeBlock: string, recallBlock: string): string {
  return [failureModeBlock, recallBlock].filter((s) => s.length > 0).join("\n\n");
}

async function fetchFailureModeBlock(repo: string): Promise<string> {
  if (!repo) return "";
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://127.0.0.1:${portValue}/api/signals/failure-modes?repo=${encodeURIComponent(repo)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: hookAuthHeaders({ "x-recall-source": "session-start-hook" }),
    }, RECALL_TIMEOUT_MS);
    if (!res.ok) return "";
    const body = (await res.json()) as { block?: string };
    return typeof body.block === "string" ? body.block : "";
  } catch {
    return "";
  }
}

/** Derive a best-effort query from SessionStart payload fields. */
function buildQuery(workingDirectory: string, projectName: string): string {
  const dirTail = workingDirectory.split("/").filter(Boolean).at(-1) ?? "";
  const parts = [dirTail, projectName].filter(Boolean);
  return parts.join(" ").trim() || "session start";
}

async function main(): Promise<void> {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: unknown;
      cwd?: unknown;
      working_directory?: unknown;
      project_name?: unknown;
    };
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const workingDirectory =
      typeof payload.cwd === "string"
        ? payload.cwd
        : typeof payload.working_directory === "string"
          ? payload.working_directory
          : "";
    const projectName =
      typeof payload.project_name === "string" ? payload.project_name : "";
    const query = buildQuery(workingDirectory, projectName);
    const mode: HookMode = hookModeFromEnv();
    const out = await runHook(
      { conversationId, query },
      {
        mode,
        recall: async (q, cid) =>
          (await recallOverHttp(q, "claude-code", cid === "unknown" ? undefined : cid, "hybrid")).hits,
      },
    );
    const failureModes = mode === "live" ? await fetchFailureModeBlock(workingDirectory) : "";
    const combined = composeSessionStartOutput(failureModes, out);
    if (combined) process.stdout.write(combined);
  } catch {
    // Fail open — never block or fail a session start.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
