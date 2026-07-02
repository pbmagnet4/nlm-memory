/**
 * Claude Code Stop hook entrypoint for NLM.
 *
 * Fires after the model finishes a response. Scans the last assistant message
 * in the transcript for substrings matching any session ID the recall hook
 * surfaced this conversation (via the dedup memo). Each match becomes a
 * citation event posted to the daemon at POST /api/recall/cite-event.
 *
 * Each citation event is the training-data substrate for a future learned reranker (was_cited per query).
 *
 * Fail-open by design: any error yields a clean exit with no output. The
 * Stop hook can never block Claude Code's response.
 */

import { pathToFileURL } from "node:url";
import {
  detectCitations,
  type CitationKind,
} from "@core/hook/citation-detect.js";
import { detectMisses } from "@core/hook/miss-detect.js";
import { loadSurfaced } from "@core/hook/memo.js";
import { loadCited, recordCited } from "@core/hook/cite-memo.js";
import { appendMisses } from "@core/recall/miss-log.js";
import {
  readAllAssistantTurns,
  type ToolUseBlock,
} from "@core/hook/transcript.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { readStdin, fetchWithTimeout, hookModeFromEnv, appendHookEvent } from "./hook-helpers.js";

const RESPONSE_PREVIEW_CHARS = 200;
const POST_TIMEOUT_MS = 1500;

export interface StopHookInput {
  readonly conversationId: string;
  readonly transcriptPath: string;
  readonly stopHookActive: boolean;
}

export interface CitationEvent {
  readonly id: string;
  readonly kind: CitationKind;
}

export interface StopHookResult {
  readonly conversationId: string;
  readonly surfacedCount: number;
  readonly citations: ReadonlyArray<CitationEvent>;
  readonly responsePreview: string;
  readonly skipped: boolean;
}

export interface RunStopHookDeps {
  readonly postCitation: (
    conversationId: string,
    citedId: string,
    kind: CitationKind,
    responsePreview: string,
  ) => Promise<void>;
}

export async function runStopHook(
  input: StopHookInput,
  deps: RunStopHookDeps,
): Promise<StopHookResult> {
  // stop_hook_active=true means Stop is firing again because a prior Stop
  // hook returned control to the model. Skip to avoid double-counting.
  if (input.stopHookActive) {
    return {
      conversationId: input.conversationId,
      surfacedCount: 0,
      citations: [],
      responsePreview: "",
      skipped: true,
    };
  }

  const surfaced = loadSurfaced(input.conversationId);
  if (surfaced.size === 0) {
    return {
      conversationId: input.conversationId,
      surfacedCount: 0,
      citations: [],
      responsePreview: "",
      skipped: false,
    };
  }

  const turns = readAllAssistantTurns(input.transcriptPath);
  if (turns.length === 0) {
    return {
      conversationId: input.conversationId,
      surfacedCount: surfaced.size,
      citations: [],
      responsePreview: "",
      skipped: false,
    };
  }

  const allToolUses: ToolUseBlock[] = [];
  const textParts: string[] = [];
  for (const turn of turns) {
    if (turn.text) textParts.push(turn.text);
    for (const tu of turn.toolUses) allToolUses.push(tu);
  }
  const unionText = textParts.join("\n");

  const detected = detectCitations({
    responseText: unionText,
    toolUses: allToolUses,
    surfacedIds: surfaced,
  });
  const alreadyCited = loadCited(input.conversationId);
  const fresh = detected.filter((c) => !alreadyCited.has(c.id));

  // Spec E: passive miss detection. Any session the agent explicitly
  // fetched via get_session / cite_session that was NOT in the surfaced
  // set is a hook-side miss — the recall gate failed to fire for a
  // session the model later cared about. Fire-and-forget: never blocks
  // the Stop hook return.
  const misses = detectMisses({ toolUses: allToolUses, surfacedIds: surfaced });
  if (misses.length > 0) {
    void appendMisses(
      misses.map((m) => ({
        conversationId: input.conversationId,
        missedId: m.id,
        kind: m.kind,
        surfacedCount: surfaced.size,
      })),
    );
  }

  // Preview is the LAST turn's prose — that's what Edward saw when Stop
  // fired. Stable substrate for the citation log even when detection
  // ranges across earlier turns.
  const lastText = turns[turns.length - 1]?.text ?? "";
  const preview = lastText.slice(0, RESPONSE_PREVIEW_CHARS);

  await Promise.allSettled(
    fresh.map((c) => deps.postCitation(input.conversationId, c.id, c.kind, preview)),
  );
  if (fresh.length > 0) {
    recordCited(input.conversationId, fresh.map((c) => c.id));
  }

  return {
    conversationId: input.conversationId,
    surfacedCount: surfaced.size,
    citations: fresh,
    responsePreview: preview,
    skipped: false,
  };
}

function logStopResult(result: StopHookResult): void {
  appendHookEvent({
    ts: new Date().toISOString(),
    kind: "stop",
    conversationId: result.conversationId,
    surfacedCount: result.surfacedCount,
    citedIds: result.citations.map((c) => c.id),
    citationKinds: result.citations.map((c) => c.kind),
    skipped: result.skipped,
    mode: hookModeFromEnv(),
  });
}

async function postCitationOverHttp(
  conversationId: string,
  citedId: string,
  kind: CitationKind,
  responsePreview: string,
): Promise<void> {
  const port = process.env["NLM_PORT"] ?? "3940";
  const url = `http://127.0.0.1:${port}/api/recall/cite-event`;
  await fetchWithTimeout(url, {
    method: "POST",
    headers: hookAuthHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      ...(conversationId !== "unknown" ? { conversation_id: conversationId } : {}),
      cited_id: citedId,
      kind,
      response_preview: responsePreview,
    }),
  }, POST_TIMEOUT_MS);
}

async function main(): Promise<void> {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: unknown;
      transcript_path?: unknown;
      stop_hook_active?: unknown;
    };
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : "";
    const stopHookActive = payload.stop_hook_active === true;

    const result = await runStopHook(
      { conversationId, transcriptPath, stopHookActive },
      { postCitation: postCitationOverHttp },
    );
    logStopResult(result);
  } catch {
    // Fail open — never block Claude Code's response.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
