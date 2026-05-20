/**
 * Append-only JSONL log for the recall hook. One line per prompt the hook
 * evaluated. This is the dataset the relevance gate (generative patterns +
 * score threshold) is calibrated against during the shadow window.
 *
 * Path defaults to ~/.nlm/hook-log.jsonl, overridable via NLM_HOOK_LOG.
 * appendHookLog swallows its own errors — telemetry must never break the hook.
 * Uses synchronous I/O: the hook is a short-lived per-prompt process, and an
 * async write could be lost if the process exits before it flushes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PromptClass } from "./gate.js";

export interface HookLogEntry {
  readonly ts: string;
  readonly conversationId: string;
  readonly promptPreview: string;
  readonly gate: PromptClass;
  readonly hits: ReadonlyArray<{ readonly id: string; readonly score: number }>;
  readonly wouldInject: ReadonlyArray<string>;
  readonly estTokens: number;
  readonly mode: "shadow" | "live";
}

function logPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

export function appendHookLog(entry: HookLogEntry): void {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    // Sync I/O: hook is a short-lived process — async write could be lost on exit.
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Telemetry failure must never break the hook.
  }
}
