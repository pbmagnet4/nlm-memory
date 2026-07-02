/**
 * Renders the pointer block injected by the recall hook in live mode. Pure.
 * Pointer-only by design: ids + labels, no session content. The footer
 * names all four NLM MCP tools because the pointer block is the only
 * cross-runtime distribution surface for teaching the tool inventory —
 * fresh-install users never edit a prompt or settings file, so anything
 * we want the agent to know about the tool surface ships here.
 *
 * Spec G.2: when `facts` is provided, a "Known facts" section is inserted
 * between the session list and the tool footer. Each fact renders as
 * `<subject> <predicate>: <value> [N sessions]` so the agent has structured
 * context alongside the session pointers.
 */

export interface PointerHit {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly summary?: string;
}

export interface PointerFact {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly corroborationCount: number;
}

export interface PointerExemplar {
  readonly outcome: string;
  readonly lang: string | null;
  readonly repo: string;
  readonly taskContext: string;
}

export function truncateSummary(s: string, max = 200): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  const last = window[window.length - 1];
  if ((last === "." || last === "!" || last === "?") && window.length - 1 >= 60) {
    return window;
  }
  for (let i = window.length - 2; i >= 60; i--) {
    const c = window[i];
    if ((c === "." || c === "!" || c === "?") && window[i + 1] === " ") {
      return s.slice(0, i + 1);
    }
  }
  for (let i = window.length - 1; i >= 60; i--) {
    if (window[i] === " ") {
      return s.slice(0, i) + " ...";
    }
  }
  return window + " ...";
}

export function formatPointerBlock(
  hits: ReadonlyArray<PointerHit>,
  facts: ReadonlyArray<PointerFact> = [],
  exemplars: ReadonlyArray<PointerExemplar> = [],
): string {
  if (hits.length === 0 && facts.length === 0 && exemplars.length === 0) return "";
  const out: string[] = [];
  if (hits.length > 0) {
    out.push("## Possibly-relevant prior sessions (nlm-memory)");
    for (const h of hits) {
      const datePart = h.startedAt.slice(0, 10);
      if (h.summary) {
        out.push(`- ${h.id} · ${h.label} (${datePart}) — ${truncateSummary(h.summary)}`);
      } else {
        out.push(`- ${h.id} · ${h.label} (${datePart})`);
      }
    }
  }
  if (facts.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Known facts about top entities");
    for (const f of facts) {
      const tag = f.corroborationCount > 1 ? ` [${f.corroborationCount} sessions]` : "";
      out.push(`- ${f.subject} ${f.predicate}: ${f.value}${tag}`);
    }
  }
  if (exemplars.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Related code exemplars (nlm-memory)");
    for (const e of exemplars) {
      const langPart = e.lang ? `${e.lang} · ` : "";
      out.push(`- [${e.outcome}] ${langPart}${e.repo} - ${truncateSummary(e.taskContext)}`);
    }
  }
  const tools = exemplars.length > 0
    ? "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved), recall_code (pull the full code for a related exemplar)."
    : "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).";
  out.push(tools);
  return out.join("\n");
}
