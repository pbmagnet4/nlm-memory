import type { WorkDigest } from "./types.js";

const PROGRESS_CAP = 8;

function hours(min: number): string {
  return (min / 60).toFixed(1) + "h";
}

function renderProgressList(items: readonly string[], emptyLine: string, label: string): string[] {
  const len = items.length;
  if (len === 0) {
    return [emptyLine];
  }
  if (len <= PROGRESS_CAP) {
    return [`  ${label} (${len}):`, ...items.map((item) => `   - ${item}`)];
  }
  const tail = items.slice(len - PROGRESS_CAP);
  const overflow = len - PROGRESS_CAP;
  return [
    `  ${label}: ${len} (showing last ${PROGRESS_CAP})`,
    ...tail.map((item) => `   - ${item}`),
    `   ... (+${overflow} more)`,
  ];
}

/** Render a WorkDigest as the shared operator-facing text. No em dashes. */
export function composeWorkDigest(d: WorkDigest): string {
  const lines: string[] = [];
  lines.push(`DAILY WORK RECAP - ${d.date}`);
  lines.push(`(${d.scopeNote})`);
  lines.push("");

  if (d.activeMinutes <= 0) {
    lines.push("no agent-assisted work recorded for this day.");
    return lines.join("\n");
  }

  const skipped =
    d.coverage.activeTimeSkipped > 0
      ? `   (${d.coverage.activeTimeSkipped} session(s): active-time not measured)`
      : "";
  lines.push(`~${hours(d.activeMinutes)} active across ${d.coverage.sessions} sessions, ${d.focus.projectsTouched} projects${skipped}`);
  lines.push("");

  lines.push("ATTENTION");
  for (const t of d.byTopic) {
    const pct = Math.round(t.share * 100) + "%";
    lines.push(`  ${t.topic}: ${pct} (${hours(t.activeMinutes)})`);
  }
  lines.push("");

  lines.push("FOCUS");
  lines.push(
    `  longest block: ${Math.round(d.focus.longestBlockMin)} min   ` +
      `context switches: ${d.focus.contextSwitches}   ` +
      `deep-work: ${Math.round(d.focus.deepWorkRatio * 100)}%`,
  );
  lines.push("");

  lines.push("PROGRESS");
  lines.push(...renderProgressList(d.progress.decisions, "  decided: none recorded", "decided"));
  lines.push(...renderProgressList(d.progress.openLoops, "  open loops: none", "open loops"));

  return lines.join("\n");
}
