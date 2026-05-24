/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content. The footer
 * names all four NLM MCP tools because the pointer block is the only
 * cross-runtime distribution surface for teaching the tool inventory —
 * fresh-install users never edit a prompt or settings file, so anything
 * we want the agent to know about the tool surface ships here.
 */
export function formatPointerBlock(hits) {
    if (hits.length === 0)
        return "";
    const lines = hits.map((h) => `- ${h.id} · ${h.label} (${h.startedAt.slice(0, 10)})`);
    return [
        "## Possibly-relevant prior sessions (nlm-memory)",
        ...lines,
        "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).",
    ].join("\n");
}
//# sourceMappingURL=pointer-block.js.map