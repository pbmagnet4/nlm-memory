import type { WorkstreamStore } from "@ports/workstream-store.js";
import { normalizeLabel } from "@core/workstream/model.js";

export type ResolvedRecallScope =
  | { status: "all"; workstreamIds?: undefined }
  | { status: "resolved"; workstreamIds: readonly [string, ...string[]] }
  | { status: "not_found"; workstreamIds: readonly [] };

export async function resolveRecallScope(
  store: WorkstreamStore, tenantId: string, idOrLabel?: string,
): Promise<ResolvedRecallScope> {
  if (idOrLabel === undefined) return { status: "all" };
  const all = await store.listAll(tenantId);
  const byId = new Map(all.map((w) => [w.id, w]));
  const survivor = (id: string): string | null => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const node = byId.get(current);
      if (!node) return null;
      if (node.mergedInto === null) return node.status === "merged" ? null : current;
      current = node.mergedInto;
    }
    return null;
  };
  const target = byId.get(idOrLabel) ?? all.find((w) => normalizeLabel(w.label) === normalizeLabel(idOrLabel));
  const root = target ? survivor(target.id) : null;
  if (!root) return { status: "not_found", workstreamIds: [] };
  const ids = all.filter((w) => survivor(w.id) === root).map((w) => w.id);
  return { status: "resolved", workstreamIds: ids as [string, ...string[]] };
}
