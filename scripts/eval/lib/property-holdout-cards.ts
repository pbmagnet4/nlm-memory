/**
 * T1142 blinded card generator. It never receives the proposed slug, lane,
 * matcher evidence or stratum, so a card cannot carry them. The bytes of this
 * file are hashed into the manifest at freeze.
 */
import type { MemoryProperty } from "../../../src/core/properties/model.js";
import { clean, context, userEvidence } from "./property-evidence.js";

const CONTEXT_CHARS = 1000;
const EXTRA_CHARS = 3000;

export interface CatalogEntry { readonly slug: string; readonly label: string }
export interface FactCard {
  readonly id: string; readonly type: "fact"; readonly runtime: string;
  readonly fact: { kind: string; subject: string; predicate: string; value: string };
  readonly userPrompts: string[]; readonly context: string; readonly catalog: CatalogEntry[];
}
export interface SessionCard {
  readonly id: string; readonly type: "session"; readonly runtime: string; readonly label: string; readonly summary: string;
  readonly userPrompts: string[]; readonly context: string; readonly extra: string; readonly catalog: CatalogEntry[];
}
export type Card = FactCard | SessionCard;

export interface FactCardSource { readonly kind: string; readonly subject: string; readonly predicate: string; readonly value: string; readonly quote: string | null; readonly body: string; readonly runtime: string }
export interface SessionCardSource { readonly label: string; readonly summary: string; readonly body: string; readonly runtime: string }

export function catalogEntries(catalog: readonly MemoryProperty[]): CatalogEntry[] {
  return catalog.map((p) => ({ slug: p.slug, label: p.label })).sort((a, b) => a.slug.localeCompare(b.slug));
}
export function factCard(id: string, source: FactCardSource, catalog: readonly MemoryProperty[]): FactCard {
  return {
    id, type: "fact", runtime: source.runtime,
    fact: { kind: source.kind, subject: source.subject, predicate: source.predicate, value: clean(source.value) },
    userPrompts: userEvidence(source.body), context: context(source.body, source.quote, source.subject).slice(0, CONTEXT_CHARS),
    catalog: catalogEntries(catalog),
  };
}
export function sessionCard(id: string, source: SessionCardSource, catalog: readonly MemoryProperty[]): SessionCard {
  return {
    id, type: "session", runtime: source.runtime, label: clean(source.label), summary: clean(source.summary),
    userPrompts: userEvidence(source.body), context: clean(source.body.slice(0, CONTEXT_CHARS)),
    extra: clean(source.body.slice(CONTEXT_CHARS, CONTEXT_CHARS + EXTRA_CHARS)), catalog: catalogEntries(catalog),
  };
}
