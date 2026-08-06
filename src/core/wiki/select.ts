/**
 * Threshold selection. Both bounds must hold: fact count alone lets one
 * chatty session mint a page, and session count alone lets a subject
 * mentioned once in each of three sessions mint a page with nothing on it.
 */
import type { SubjectStat } from "@ports/fact-store.js";
import type { WikiConfig } from "./types.js";

export function selectSubjects(
  stats: ReadonlyArray<SubjectStat>,
  config: WikiConfig,
): ReadonlyArray<SubjectStat> {
  return stats
    .filter((s) => s.factCount >= config.minFacts && s.sessionCount >= config.minSessions)
    .slice()
    .sort((a, b) => b.factCount - a.factCount || a.subject.localeCompare(b.subject));
}
