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

export function formatPointerBlock(hits: ReadonlyArray<PointerHit>): string {
  if (hits.length === 0) return "";
  const lines = hits.map(
    (h) => `- ${h.id} · ${h.label} (${h.startedAt.slice(0, 10)})`,
  );
  return [
    "## Possibly-relevant prior sessions (nlm-memory)",
    ...lines,
    "Pull detail with the recall_sessions / get_session MCP tools if relevant.",
  ].join("\n");
}
