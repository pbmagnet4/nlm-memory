/**
 * Read the last assistant message from a Claude Code transcript JSONL.
 *
 * Claude Code passes `transcript_path` in the Stop hook payload. Each line is
 * a JSON object; assistant turns have `type:"assistant"` and a `message`
 * object whose `content` is an array of blocks (`{type:"text", text:...}` for
 * prose; `{type:"tool_use", name, input}` for tool invocations).
 *
 * Two reads, one walk: `readLastAssistantTurn` parses every block of the
 * last assistant turn and returns both the prose text AND the tool_use
 * blocks. Stop-hook citation detection needs both — prose for substring
 * matches, tool_use for the strong signal that the model invoked an NLM
 * MCP tool referencing a surfaced session ID.
 *
 * Fail-quiet: a malformed file yields nulls/empty rather than throwing —
 * the Stop hook must never break on transcript I/O.
 */

import { existsSync, readFileSync } from "node:fs";

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
}
interface AssistantMessage {
  readonly content?: ReadonlyArray<ContentBlock> | string;
}
interface TranscriptLine {
  readonly type?: string;
  readonly message?: AssistantMessage;
}

export interface ToolUseBlock {
  readonly name: string;
  readonly input: unknown;
}

export interface AssistantTurn {
  readonly text: string;
  readonly toolUses: ReadonlyArray<ToolUseBlock>;
}

const EMPTY_TURN: AssistantTurn = { text: "", toolUses: [] };

export function readLastAssistantTurn(transcriptPath: string): AssistantTurn {
  if (!transcriptPath || !existsSync(transcriptPath)) return EMPTY_TURN;
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return EMPTY_TURN;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type !== "assistant" || !parsed.message) continue;
    const content = parsed.message.content;
    if (typeof content === "string") {
      return { text: content, toolUses: [] };
    }
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      const toolUses: ToolUseBlock[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          toolUses.push({ name: block.name, input: block.input });
        }
      }
      if (textParts.length > 0 || toolUses.length > 0) {
        return { text: textParts.join("\n"), toolUses };
      }
    }
  }
  return EMPTY_TURN;
}

/** Back-compat shim for callers that only need prose. */
export function readLastAssistantText(transcriptPath: string): string | null {
  const turn = readLastAssistantTurn(transcriptPath);
  return turn.text || null;
}
