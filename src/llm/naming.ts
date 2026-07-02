import type { WorkstreamCandidateHint } from "@ports/llm-client.js";

export function buildNamingSystemPrompt(
  candidates: ReadonlyArray<WorkstreamCandidateHint>,
  opts?: { readonly noThinkSuffix?: boolean },
): string {
  const list = candidates.map((c) => `- ${c.label}`).join("\n");
  return (
    `You label a work session by which project it belongs to. Known projects:\n${list}\n` +
    `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none".` +
    (opts?.noThinkSuffix ? " /no_think" : "")
  );
}

export function parseLongestLabel(
  out: string,
  candidates: ReadonlyArray<WorkstreamCandidateHint>,
): string | null {
  const lower = out.toLowerCase();
  let best: string | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    if (lower.includes(c.label.toLowerCase()) && c.label.length > bestLen) {
      best = c.label;
      bestLen = c.label.length;
    }
  }
  return best;
}
