/**
 * Thread chain grouping for the replaced-session affordance (#299).
 *
 * A "replaces chain" is the linear sequence of mechanical re-parses that
 * culminate in a single live (non-replaced) session. Superseded sessions
 * are NOT grouped — operator overturn stays dimmed-but-visible as individual
 * rows.
 *
 * Orphaned replaced sessions (status === "replaced" but no live successor in
 * the filtered set) render ungrouped rather than being dropped, so the audit
 * trail is never hidden.
 */

import type { DatasetSession } from "./dataset.js";

export interface SessionGroup {
  /** The live (non-replaced) session at the head of the chain. */
  readonly live: DatasetSession;
  /** Earlier versions in the chain, oldest first. Empty when no predecessors. */
  readonly earlier: ReadonlyArray<DatasetSession>;
}

export interface SessionGroupOrOrphan {
  readonly kind: "group";
  readonly group: SessionGroup;
}

export interface OrphanSession {
  readonly kind: "orphan";
  readonly session: DatasetSession;
}

export type ThreadItem = SessionGroupOrOrphan | OrphanSession;

/**
 * Group a flat session list by replaces-chains.
 *
 * - Non-replaced sessions → `{ kind: "group", group: { live, earlier: [] } }` if no predecessors,
 *   or `{ kind: "group", group: { live, earlier: [pred, ...] } }` if they head a chain.
 * - Replaced sessions whose chain-head is present in `sessions` → included in
 *   that group's `earlier` array (oldest first), not emitted as top-level items.
 * - Replaced sessions with no live successor in `sessions` → emitted as
 *   `{ kind: "orphan", session }` so they're rendered ungrouped.
 * - Superseded sessions → emitted as `{ kind: "orphan", session }` (pass-through,
 *   never collapsed).
 *
 * The output preserves the ordering of non-replaced sessions from the input array.
 */
export function groupByReplaceChain(sessions: ReadonlyArray<DatasetSession>): ThreadItem[] {
  const byId = new Map<string, DatasetSession>(sessions.map((s) => [s.id, s]));

  // Walk the replaces chain from each session forward to find its live head.
  // Cache results to avoid re-walking.
  const headCache = new Map<string, string | null>();

  function liveHead(id: string): string | null {
    if (headCache.has(id)) return headCache.get(id)!;
    const s = byId.get(id);
    if (!s) { headCache.set(id, null); return null; }
    if (s.status !== "replaced") { headCache.set(id, id); return id; }
    // Walk to the session that replaced this one (replaced_by points forward).
    const nextId = s.replaced_by;
    if (!nextId) { headCache.set(id, null); return null; }
    const result = liveHead(nextId);
    headCache.set(id, result);
    return result;
  }

  // Build earlier-versions lists for each chain-head.
  const earlierByHead = new Map<string, DatasetSession[]>();
  const replacedIds = new Set<string>();

  for (const s of sessions) {
    if (s.status !== "replaced") continue;
    replacedIds.add(s.id);
    const head = liveHead(s.id);
    if (head !== null) {
      const list = earlierByHead.get(head) ?? [];
      list.push(s);
      earlierByHead.set(head, list);
    }
  }

  // Sort earlier arrays by started_at ascending (oldest first).
  for (const [, list] of earlierByHead) {
    list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  }

  const items: ThreadItem[] = [];
  for (const s of sessions) {
    if (replacedIds.has(s.id)) {
      // This is a replaced session — it will appear inside a group or as orphan.
      if (liveHead(s.id) === null) {
        // No live successor in the current set — render ungrouped.
        items.push({ kind: "orphan", session: s });
      }
      // Otherwise it's subsumed into its head's group; skip.
      continue;
    }
    // Non-replaced session (active, closed, idle, superseded).
    items.push({
      kind: "group",
      group: { live: s, earlier: earlierByHead.get(s.id) ?? [] },
    });
  }

  return items;
}
