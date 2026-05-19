/**
 * Session-list filters used before scoring.
 *
 * Pure function over a session array. Mirrors recall.py:_apply_filters.
 */

import type { Session, RecallKindFilter } from "@shared/types.js";

export interface RecallFilter {
  readonly entity?: string;
  readonly kind?: RecallKindFilter;
}

export function applyFilter(
  sessions: ReadonlyArray<Session>,
  filter: RecallFilter,
): ReadonlyArray<Session> {
  const { entity, kind } = filter;
  if (!entity && !kind) return sessions;

  return sessions.filter((s) => {
    if (entity && !s.entities.includes(entity)) return false;
    if (kind === "decision" && s.decisions.length === 0) return false;
    if (kind === "open" && s.open.length === 0) return false;
    return true;
  });
}
