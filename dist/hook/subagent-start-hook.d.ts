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
 * Daemon endpoint: POST localhost:3940/api/hook/subagent-start
 * This endpoint does NOT exist yet in the daemon — the hook ships fail-soft
 * (swallows errors). The daemon-side handler is a follow-up task.
 *
 * Payload: { parent_conversation_id, subagent_session_id, subagent_description, ts }
 *
 * Fail-open by design: any error yields a clean exit with no output.
 */
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
export declare function runSubagentStart(input: SubagentStartInput, portValue?: string): Promise<SubagentStartResult>;
