/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content. The footer
 * names all four NLM MCP tools because the pointer block is the only
 * cross-runtime distribution surface for teaching the tool inventory —
 * fresh-install users never edit a prompt or settings file, so anything
 * we want the agent to know about the tool surface ships here.
 */
export interface PointerHit {
    readonly id: string;
    readonly label: string;
    readonly startedAt: string;
}
export declare function formatPointerBlock(hits: ReadonlyArray<PointerHit>): string;
