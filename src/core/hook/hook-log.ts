/**
 * Append-only JSONL log for the recall hook. One line per prompt the hook
 * evaluated. This is the dataset the relevance gate (generative patterns +
 * score threshold) is calibrated against during the shadow window.
 *
 * Path is tenant-derived (core/tenancy/tenant-state-path.ts): the default
 * team's log is ~/.nlm/hook-log.jsonl, overridable via NLM_HOOK_LOG; every
 * other tenant is isolated under ~/.nlm/tenants/<tenantId>/hook-log.jsonl
 * and ignores the env override.
 * appendHookLog swallows its own errors — telemetry must never break the hook.
 * Uses synchronous I/O: the hook is a short-lived per-prompt process, and an
 * async write could be lost if the process exits before it flushes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
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
  /** Per-candidate relevance-gate decisions, when the recall gate ran. */
  readonly gateDecisions?: ReadonlyArray<{ readonly id: string; readonly gate: "relevant" | "irrelevant" }>;
}

function logPath(tenantId: string): string {
  if (tenantId === DEFAULT_TEAM_ID) {
    return process.env["NLM_HOOK_LOG"] ?? tenantStatePath(tenantId, "hook-log.jsonl");
  }
  return tenantStatePath(tenantId, "hook-log.jsonl");
}

export function appendHookLog(tenantId: string, entry: HookLogEntry): void {
  try {
    const path = logPath(tenantId);
    mkdirSync(dirname(path), { recursive: true });
    // Sync I/O: hook is a short-lived process — async write could be lost on exit.
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Telemetry failure must never break the hook.
  }
}
