/**
 * Computes which session fields a keyword query matched, for the `matchedIn`
 * badge on a RecallHit. Pure function — no DB, no I/O. FTS5 BM25 ranks the
 * whole row; this recovers per-field attribution from the resolved Session,
 * including decisions/open which live in the markers table (not in FTS).
 */

import type { MatchField, Session } from "@shared/types.js";
import { tokenSet } from "./tokenize.js";

type SessionFields = Pick<Session, "label" | "summary" | "decisions" | "open">;

export function keywordMatchFields(
  session: SessionFields,
  queryTokens: ReadonlySet<string>,
): ReadonlyArray<MatchField> {
  if (queryTokens.size === 0) return [];
  const fields: MatchField[] = [];

  if (overlaps(queryTokens, tokenSet(session.label))) fields.push("label");
  if (overlaps(queryTokens, joinedTokens(session.decisions))) fields.push("decisions");
  if (overlaps(queryTokens, joinedTokens(session.open))) fields.push("open");
  if (overlaps(queryTokens, tokenSet(session.summary))) fields.push("summary");

  return fields;
}

function joinedTokens(values: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    for (const t of tokenSet(v)) out.add(t);
  }
  return out;
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) return true;
  return false;
}
