// src/core/workstream/compose-recall.ts
import type { WorkstreamRollup } from "./model.js";

export function composeWorkstreamRecall(view: WorkstreamRollup): string {
  const { workstream, sessionIds, facts, exemplars } = view;
  const lines: string[] = [];
  lines.push(`WORKSTREAM: ${workstream.label}`);
  lines.push(`(${sessionIds.length} sessions${workstream.lastSessionAt ? `, last active ${workstream.lastSessionAt.slice(0, 10)}` : ""})`);
  lines.push("");

  const decisions = facts.filter((f) => f.kind === "decision");
  const open = facts.filter((f) => f.kind === "open");
  const attrs = facts.filter((f) => f.kind === "attribute");

  if (decisions.length) {
    lines.push("DECISIONS:");
    for (const f of decisions) lines.push(`  - ${f.value}`);
    lines.push("");
  }
  if (open.length) {
    lines.push("OPEN LOOPS:");
    for (const f of open) lines.push(`  - ${f.value}`);
    lines.push("");
  }
  if (attrs.length) {
    lines.push("FACTS:");
    for (const f of attrs) lines.push(`  - ${f.subject} ${f.predicate} ${f.value}`);
    lines.push("");
  }
  if (exemplars.length) {
    lines.push("CODE EXEMPLARS:");
    for (const e of exemplars) lines.push(`  - [${e.outcome}] ${e.repo}: ${e.taskContext}`);
    lines.push("");
  }
  if (!decisions.length && !open.length && !attrs.length && !exemplars.length) {
    lines.push("(no accumulated facts or exemplars yet)");
  }
  return lines.join("\n").trimEnd();
}
