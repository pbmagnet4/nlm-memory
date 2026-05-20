/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content — the agent
 * pulls detail via the recall_sessions / get_session MCP tools.
 */
export interface PointerHit {
    readonly id: string;
    readonly label: string;
    readonly startedAt: string;
}
export declare function formatPointerBlock(hits: ReadonlyArray<PointerHit>): string;
