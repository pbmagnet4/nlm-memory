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
export interface ToolUseBlock {
    readonly name: string;
    readonly input: unknown;
}
export interface AssistantTurn {
    readonly text: string;
    readonly toolUses: ReadonlyArray<ToolUseBlock>;
}
export declare function readLastAssistantTurn(transcriptPath: string): AssistantTurn;
/** Back-compat shim for callers that only need prose. */
export declare function readLastAssistantText(transcriptPath: string): string | null;
