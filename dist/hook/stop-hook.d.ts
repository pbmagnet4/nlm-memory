/**
 * Claude Code Stop hook entrypoint for NLM.
 *
 * Fires after the model finishes a response. Scans the last assistant message
 * in the transcript for substrings matching any session ID the recall hook
 * surfaced this conversation (via the dedup memo). Each match becomes a
 * citation event posted to the daemon at POST /api/recall/cite-event.
 *
 * Double duty:
 *  - Per-recall useful_hit_rate metric (was the returned ID actually used?)
 *  - Training-data substrate for a learned reranker (was_cited per query)
 *
 * Fail-open by design: any error yields a clean exit with no output. The
 * Stop hook can never block Claude Code's response.
 */
import { type CitationKind } from "../core/hook/citation-detect.js";
export interface StopHookInput {
    readonly conversationId: string;
    readonly transcriptPath: string;
    readonly stopHookActive: boolean;
}
export interface CitationEvent {
    readonly id: string;
    readonly kind: CitationKind;
}
export interface StopHookResult {
    readonly conversationId: string;
    readonly surfacedCount: number;
    readonly citations: ReadonlyArray<CitationEvent>;
    readonly responsePreview: string;
    readonly skipped: boolean;
}
export interface RunStopHookDeps {
    readonly postCitation: (conversationId: string, citedId: string, kind: CitationKind, responsePreview: string) => Promise<void>;
}
export declare function runStopHook(input: StopHookInput, deps: RunStopHookDeps): Promise<StopHookResult>;
