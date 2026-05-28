/**
 * Claude Code PreCompact hook entrypoint for NLM.
 *
 * Fires before Claude Code compacts a long transcript. At compaction time the
 * in-flight surfaced-IDs memo and any pending citation state would be lost.
 * This hook POSTs a compaction event to the daemon so it can do a final
 * synchronous citation scan of the transcript before the shape is lost.
 *
 * Daemon endpoint: POST localhost:3940/api/hook/pre-compact
 * This endpoint does NOT exist yet in the daemon — the hook ships fail-soft
 * (swallows errors) so it won't block compaction when the endpoint is absent.
 * The daemon-side handler is a follow-up task.
 *
 * Payload: { conversation_id, transcript_path, surfaced_set, ts }
 *
 * Fail-open by design: any error yields a clean exit with no output.
 */
export interface PreCompactInput {
    readonly conversationId: string;
    readonly transcriptPath: string;
}
export interface PreCompactResult {
    readonly conversationId: string;
    readonly posted: boolean;
}
export declare function runPreCompact(input: PreCompactInput, portValue?: string): Promise<PreCompactResult>;
