// src/core/workstream/resolve.ts

/**
 * Walk the merged_into chain to the live survivor. Mirrors the replaces-chain
 * resolution in ui/lib/thread-groups.ts. Iterative + visited-set guarded so a
 * (data-corrupt) cycle terminates instead of looping. Fail-open: an id absent
 * from the map resolves to itself.
 */
export function resolveWorkstreamId(
  id: string,
  byId: ReadonlyMap<string, { id: string; mergedInto: string | null }>,
): string {
  const seen = new Set<string>();
  let cur = id;
  while (true) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node || node.mergedInto === null) return cur;
    cur = node.mergedInto;
  }
}
