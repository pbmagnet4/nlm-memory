/**
 * Pure heuristic intent classifier for recall queries.
 * Total: never throws, always returns one of the four labels.
 * Dependency-free: uses only detectQueryShape from this directory.
 */

import { detectQueryShape } from "./query-shape.js";

export type QueryIntent = "lookup" | "relational" | "temporal" | "other";

const RELATIONAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdepends\s+on\b/i,
  /\brelated\s+to\b/i,
  /\bconnected\s+(to|with)\b/i,
  /\bwhat\s+uses\b/i,
  /\bdownstream\s+of\b/i,
];

export function classifyQueryIntent(query: string): QueryIntent {
  if (!query.trim()) return "other";
  for (const pat of RELATIONAL_PATTERNS) {
    if (pat.test(query)) return "relational";
  }
  if (detectQueryShape(query).hasTemporal) return "temporal";
  return "lookup";
}
