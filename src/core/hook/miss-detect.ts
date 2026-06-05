/**
 * Detect "recall misses" — sessions the agent explicitly fetched or cited
 * in its response but which the hook's pre-prompt recall never surfaced
 * in this conversation.
 *
 * A miss is the inverse signal of a citation:
 *  - Citation = surfaced id appeared in the agent's tool calls / prose
 *  - Miss     = id appeared in a get_session(id) or cite_session(id) call
 *               but was NOT surfaced
 *
 * Only explicit-id tool_use calls count. We don't scan recall_sessions
 * results — those are exploratory and don't mean the agent thought any
 * specific returned id was the right answer. get_session and cite_session,
 * by contrast, are deterministic single-id signals: "I want this session
 * specifically" or "I am citing this exact session."
 *
 * Aggregated miss data shows where the hook's selection gate is wrong —
 * sessions that were relevant but didn't score high enough to fire. Spec E
 * v1 is passive: just log, surface via the `nlm misses` CLI for review.
 * Future specs may consume this data to retrain reranking or trigger
 * targeted reclassification.
 */

import type { ToolUseBlock } from "./transcript.js";

export interface DetectedMiss {
  readonly id: string;
  readonly kind: "get_session" | "cite_session";
}

export interface MissDetectInput {
  readonly toolUses: ReadonlyArray<ToolUseBlock>;
  readonly surfacedIds: Iterable<string>;
}

const MIN_ID_LEN = 6;

export function detectMisses(input: MissDetectInput): DetectedMiss[] {
  const surfaced = new Set<string>();
  for (const id of input.surfacedIds) {
    if (id.length >= MIN_ID_LEN) surfaced.add(id);
  }

  const seenMissed = new Set<string>();
  const misses: DetectedMiss[] = [];

  for (const tu of input.toolUses) {
    if (!isNlmTool(tu.name)) continue;
    const kind = explicitIdKind(tu.name);
    if (!kind) continue;
    const id = extractId(tu.input);
    if (!id || id.length < MIN_ID_LEN) continue;
    if (surfaced.has(id)) continue;
    if (seenMissed.has(id)) continue;
    seenMissed.add(id);
    misses.push({ id, kind });
  }

  return misses;
}

function isNlmTool(name: string): boolean {
  return /^mcp__[^_]*nlm[^_]*__/.test(name);
}

function explicitIdKind(name: string): DetectedMiss["kind"] | null {
  if (name.endsWith("__get_session")) return "get_session";
  if (name.endsWith("__cite_session")) return "cite_session";
  return null;
}

function extractId(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const candidate = obj["id"];
  return typeof candidate === "string" ? candidate : null;
}
