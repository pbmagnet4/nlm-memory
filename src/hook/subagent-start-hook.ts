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
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${portValue}/api/hook/subagent-start`, {
      method: "POST",
      headers: hookAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
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
  } finally {
    clearTimeout(timer);
  }
}

function logPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

function logResult(result: SubagentStartResult): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: "subagent-start",
        parentConversationId: result.parentConversationId,
        subagentSessionId: result.subagentSessionId,
        posted: result.posted,
      })}\n`,
      "utf8",
    );
  } catch {
    // Telemetry failure must never break the hook.
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
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
