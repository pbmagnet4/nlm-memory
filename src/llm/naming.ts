import type { WorkstreamCandidateHint } from "@ports/llm-client.js";

export function buildNamingSystemPrompt(
  candidates: ReadonlyArray<WorkstreamCandidateHint>,
  opts?: { readonly noThinkSuffix?: boolean },
): string {
  const list = candidates
    .map((c) => (c.aliases.length > 0 ? `- ${c.label} (aka ${c.aliases.join(", ")})` : `- ${c.label}`))
    .join("\n");
  return (
    `You label a work session by which project it belongs to. Known projects:\n${list}\n` +
    `Answer with a project name only when the session's actual work is on that project; a passing mention is not enough. ` +
    `If it belongs to NONE of these, or you are unsure, answer "none". Reply with ONLY the exact project name from the list, or "none".` +
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
