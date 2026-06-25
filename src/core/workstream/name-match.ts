// src/core/workstream/name-match.ts
import { normalizeLabel, type Workstream } from "./model.js";

export type NameDecision = { kind: "bind"; workstreamId: string } | { kind: "abstain" };

export function decideWorkstreamByName(
  named: string | null,
  workstreams: ReadonlyArray<Pick<Workstream, "id" | "label">>,
  aliasToLabel: ReadonlyMap<string, string>,
): NameDecision {
  if (!named || !named.trim()) return { kind: "abstain" };
  const byLabel = new Map(workstreams.map((w) => [normalizeLabel(w.label), w.id]));
  const direct = byLabel.get(normalizeLabel(named));
  if (direct) return { kind: "bind", workstreamId: direct };
  const canonical = aliasToLabel.get(normalizeLabel(named));
  if (canonical) {
    const viaAlias = byLabel.get(normalizeLabel(canonical));
    if (viaAlias) return { kind: "bind", workstreamId: viaAlias };
  }
  return { kind: "abstain" };
}
