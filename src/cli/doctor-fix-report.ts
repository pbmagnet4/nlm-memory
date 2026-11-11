/** Console lines for `nlm doctor`: the repairs --fix applied and the ones a dry run would apply. */

import type { ConflictRepair, DanglingRepair, FixReport } from "../core/integrity/check-invariants.js";

export function conflictRepairLine(prefix: string, r: ConflictRepair): string {
  return `  ${prefix} ${r.tenantId} ${r.subject} | ${r.predicate}: kept ${r.keptId}, superseded ${r.supersededIds.join(", ")}`;
}

export function danglingRepairLine(prefix: string, r: DanglingRepair): string {
  const outcome = r.supersededBy === null ? `returned to active${r.alsoSuperseded.length > 0 ? `, superseded ${r.alsoSuperseded.join(", ")}` : ""}` : `now superseded by ${r.supersededBy}`;
  return `  ${prefix} ${r.tenantId} ${r.subject} | ${r.predicate}: ${r.factId} ${outcome}`;
}

export function fixReportLines(report: FixReport): string[] {
  const lines: string[] = [];
  if (report.deletedSelfLoops > 0) lines.push(`  fixed I1: deleted ${report.deletedSelfLoops} self-loop edge(s)`);
  if (report.restoredToClosed > 0) lines.push(`  fixed I2: restored ${report.restoredToClosed} session(s) to closed`);
  if (report.ghostGuardRefusal) lines.push(`  skipped I7: refused by sweep guard: ${report.ghostGuardRefusal}`);
  if (report.deletedGhostEmbeddings > 0) lines.push(`  fixed I7: deleted ${report.deletedGhostEmbeddings} ghost embedding(s)`);
  if (report.orphanChunkGuardRefusal) lines.push(`  skipped I7b-1: refused by sweep guard: ${report.orphanChunkGuardRefusal}`);
  if (report.deletedOrphanChunkIds.length > 0) {
    lines.push(`  fixed I7b-1: deleted ${report.deletedOrphanChunkIds.length} map-less chunk vector(s): chunk_id ${report.deletedOrphanChunkIds.join(", ")}`);
  }
  for (const r of report.supersededConflicts) lines.push(conflictRepairLine("fixed I5a: superseded", r));
  for (const r of report.repairedDangling) lines.push(danglingRepairLine("fixed I5b:", r));
  if (
    report.deletedSelfLoops === 0 && report.restoredToClosed === 0 && report.deletedGhostEmbeddings === 0 &&
    report.deletedOrphanChunkIds.length === 0 && report.supersededConflicts.length === 0 && report.repairedDangling.length === 0 &&
    !report.ghostGuardRefusal && !report.orphanChunkGuardRefusal
  ) {
    lines.push("  --fix: nothing to repair");
  }
  return lines;
}
