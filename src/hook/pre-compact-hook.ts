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
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadSurfaced } from "@core/hook/memo.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { hookAuthHeaders } from "./hook-auth.js";

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
  portValue = process.env["NLM_PORT"] ?? "3940",
): Promise<PreCompactResult> {
  const surfacedSet = [...loadSurfaced(input.conversationId)];
  const payload = {
    conversation_id: input.conversationId,
    transcript_path: input.transcriptPath,
    surfaced_set: surfacedSet,
    ts: new Date().toISOString(),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${portValue}/api/hook/pre-compact`, {
      method: "POST",
      headers: hookAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { conversationId: input.conversationId, posted: res.ok };
  } catch {
    return { conversationId: input.conversationId, posted: false };
  } finally {
    clearTimeout(timer);
  }
}

function logPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

function logResult(result: PreCompactResult): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: "pre-compact",
        conversationId: result.conversationId,
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
