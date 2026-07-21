/**
 * Claude Code PreCompact hook entrypoint for NLM.
 *
 * Fires before Claude Code compacts a long transcript. At compaction time the
 * in-flight surfaced-IDs memo and any pending citation state would be lost.
 * This hook POSTs a compaction event to the daemon so it can do a final
 * synchronous citation scan of the transcript before the shape is lost.
 *
 * Daemon endpoint: POST /api/hook/pre-compact
 *
 * Payload: { conversation_id, transcript_path, surfaced_set, ts }
 *
 * Fail-open by design: any error yields a clean exit with no output.
 */

import { pathToFileURL } from "node:url";
import { loadSurfaced } from "@core/hook/memo.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";
import { readStdin, fetchWithTimeout, appendHookEvent } from "./hook-helpers.js";
import { DEFAULT_NLM_PORT } from "../shared/net.js";

const POST_TIMEOUT_MS = 1500;

export interface PreCompactInput {
  readonly conversationId: string;
  readonly transcriptPath: string;
}

export interface PreCompactResult {
  readonly conversationId: string;
  readonly posted: boolean;
}

export async function runPreCompact(
  input: PreCompactInput,
  portValue = process.env["NLM_PORT"] ?? DEFAULT_NLM_PORT,
): Promise<PreCompactResult> {
  const surfacedSet = [...loadSurfaced(input.conversationId)];
  const payload = {
    conversation_id: input.conversationId,
    transcript_path: input.transcriptPath,
    surfaced_set: surfacedSet,
    ts: new Date().toISOString(),
  };
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${portValue}/api/hook/pre-compact`,
      {
        method: "POST",
        headers: hookAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload),
      },
      POST_TIMEOUT_MS,
    );
    return { conversationId: input.conversationId, posted: res.ok };
  } catch {
    return { conversationId: input.conversationId, posted: false };
  }
}

function logResult(result: PreCompactResult): void {
  appendHookEvent({
    ts: new Date().toISOString(),
    kind: "pre-compact",
    conversationId: result.conversationId,
    posted: result.posted,
  });
}

async function main(): Promise<void> {
  try {
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      session_id?: unknown;
      transcript_path?: unknown;
    };
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : "";
    const result = await runPreCompact({ conversationId, transcriptPath });
    logResult(result);
  } catch {
    // Fail open — never block Claude Code compaction.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
