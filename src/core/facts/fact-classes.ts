/**
 * Predicate-level fact classes (T737 / E6).
 *
 *   state  latest value wins: a newer fact for the same (subject, predicate)
 *          supersedes the older one (the long-standing ingest collapse).
 *   event  every fact is kept: facets and successive observations coexist, so
 *          nothing is superseded on write and I5a does not count them.
 *
 * The table is derived from the conflicting active groups of the 2026-10-15
 * eval snapshot (docs/fact-classes.md): a predicate is `event` only when none
 * of its conflicting groups was a true replacement. A predicate with no
 * conflict evidence stays `state`, the behaviour before this table. A string
 * outside the closed predicate vocabulary is `event`, the safe default: it is
 * never superseded by this table's rules.
 *
 * NLM_FACT_CLASSES=on makes ingest honour the event class. Default off: the
 * collapse is unchanged, only the I5a report exempts event predicates.
 */

import { PREDICATE_VOCABULARY } from "@core/classifier/prompt.js";

export type FactClass = "state" | "event";

const EVENT_PREDICATES = ["endpoint", "owner", "repo", "runtime", "version"] as const;

const EVENT_SET: ReadonlySet<string> = new Set(EVENT_PREDICATES);
const VOCAB: ReadonlySet<string> = new Set(PREDICATE_VOCABULARY);

export function factClassOf(predicate: string): FactClass {
  if (!VOCAB.has(predicate)) return "event";
  return EVENT_SET.has(predicate) ? "event" : "state";
}

/** Predicates whose facts are never superseded by the class rules. */
export const EVENT_CLASS_PREDICATES: ReadonlyArray<string> = EVENT_PREDICATES;

export function factClassesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["NLM_FACT_CLASSES"] ?? "off").trim().toLowerCase() === "on";
}
