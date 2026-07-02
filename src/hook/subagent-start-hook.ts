/**
 * Claude Code SubagentStart hook entrypoint for NLM.
 *
 * Fires when Claude Code dispatches a subagent (Agent tool). Subagents have
 * their own session IDs but are invisible to NLM's session corpus today.
 * This hook captures the parent→subagent link so NLM can correlate subagent
 * transcripts back to the dispatching conversation when SessionEnd fires.
 *
 * Capture-only. No recall injection — subagents inherit context from their
 * dispatch prompt; additional recall would pollute their narrow task scope.
 *
 * Daemon endpoint: POST /api/hook/subagent-start
 *
 * Payload: { parent_conversation_id, subagent_session_id, subagent_description, ts }
 *
 * Fail-open by design: any error yields a clean exit with no output.
 */

import { pathToFileURL } from "node:url";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { readStdin, fetchWithTimeout, appendHookEvent } from "./hook-helpers.js";

const POST_TIMEOUT_MS = 1500;

export interface SubagentStartInput {
  readonly parentConversationId: string;
  readonly subagentSessionId: string;
  readonly subagentDescription: string;
}

export interface SubagentStartResult {
  readonly parentConversationId: string;
  readonly subagentSessionId: string;
  readonly posted: boolean;
}

export async function runSubagentStart(
  input: SubagentStartInput,
  portValue = process.env["NLM_PORT"] ?? "3940",
): Promise<SubagentStartResult> {
  const payload = {
    parent_conversation_id: input.parentConversationId,
    subagent_session_id: input.subagentSessionId,
    subagent_description: input.subagentDescription,
    ts: new Date().toISOString(),
  };
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${portValue}/api/hook/subagent-start`,
      {
        method: "POST",
        headers: hookAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload),
      },
      POST_TIMEOUT_MS,
    );
    return {
      parentConversationId: input.parentConversationId,
      subagentSessionId: input.subagentSessionId,
      posted: res.ok,
    };
  } catch {
    return {
      parentConversationId: input.parentConversationId,
      subagentSessionId: input.subagentSessionId,
      posted: false,
    };
  }
}

function logResult(result: SubagentStartResult): void {
  appendHookEvent({
    ts: new Date().toISOString(),
    kind: "subagent-start",
    parentConversationId: result.parentConversationId,
    subagentSessionId: result.subagentSessionId,
    posted: result.posted,
  });
}

async function main(): Promise<void> {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: unknown;
      parent_session_id?: unknown;
      description?: unknown;
    };
    const subagentSessionId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const parentConversationId =
      typeof payload.parent_session_id === "string" ? payload.parent_session_id : "unknown";
    const subagentDescription =
      typeof payload.description === "string" ? payload.description : "";
    const result = await runSubagentStart({
      parentConversationId,
      subagentSessionId,
      subagentDescription,
    });
    logResult(result);
  } catch {
    // Fail open — never block subagent dispatch.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
