/**
 * Claude Code SessionEnd hook entrypoint for NLM.
 *
 * Fires when a Claude Code session closes. Deletes the per-conversation
 * memo file written during the session so memo files don't accumulate
 * indefinitely under ~/.nlm/hook-state/.
 *
 * Logs one JSON line per invocation to ~/.nlm/hook-log.jsonl with
 * `kind: "session-end"` so the daily-digest liveness check can correlate
 * Claude Code session closes against hook fires the same way it does for
 * UserPromptSubmit. Fail-open by design: any error yields a clean exit
 * with no output, so the hook can never block Claude Code shutdown.
 */

import { pathToFileURL } from "node:url";
import { clearSurfaced } from "@core/hook/memo.js";
import { clearCited } from "@core/hook/cite-memo.js";
import { readStdin, hookModeFromEnv, appendHookEvent } from "./hook-helpers.js";

export interface SessionEndResult {
  readonly conversationId: string;
  readonly cleared: boolean;
}

export function runSessionEnd(conversationId: string): SessionEndResult {
  const surfacedCleared = clearSurfaced(conversationId);
  const citedCleared = clearCited(conversationId);
  return { conversationId, cleared: surfacedCleared || citedCleared };
}

function logSessionEnd(result: SessionEndResult): void {
  appendHookEvent({
    ts: new Date().toISOString(),
    kind: "session-end",
    conversationId: result.conversationId,
    cleared: result.cleared,
    mode: hookModeFromEnv(),
  });
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as { session_id?: unknown };
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    logSessionEnd(runSessionEnd(conversationId));
  } catch {
    // Fail open — never block Claude Code shutdown.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
