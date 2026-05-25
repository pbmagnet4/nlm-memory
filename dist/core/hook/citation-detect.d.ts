/**
 * Detects which surfaced recall IDs an assistant turn cited.
 *
 * Two channels, ordered by signal strength:
 *  - tool_use:  the model invoked an MCP NLM tool (get_session, recall_facts,
 *               get_fact_history, recall_sessions) whose input references a
 *               surfaced ID. This is the strong "the model dug into the
 *               surfaced session" signal. Almost no false positives.
 *  - prose:     the surfaced ID appears as a substring in the response text.
 *               Models rarely echo session IDs verbatim, so this channel
 *               fires in practice almost never — kept for completeness.
 *
 * Returns both the union of cited IDs and the per-ID channel so the citation
 * log can carry kind metadata. ID minimum length keeps generic short tokens
 * from false-positiving against either channel.
 *
 * This is the training-data substrate for a future learned reranker.
 */
import type { ToolUseBlock } from "./transcript.js";
export type CitationKind = "tool_use" | "prose";
export interface CitationDetectInput {
    readonly responseText: string;
    readonly toolUses: ReadonlyArray<ToolUseBlock>;
    readonly surfacedIds: Iterable<string>;
}
export interface DetectedCitation {
    readonly id: string;
    readonly kind: CitationKind;
}
export declare function detectCitations(input: CitationDetectInput): DetectedCitation[];
/** Back-compat: prose-only detector returning a flat id list. */
export declare function detectCitedIds(responseText: string, surfacedIds: Iterable<string>): string[];
