/**
 * Frozen T1142 stratum predicates. They read source text and session metadata
 * only, never the candidate's output. The bytes of this file are hashed into
 * the manifest at freeze; editing it afterwards voids the run.
 */
import type { MemoryProperty } from "../../../src/core/properties/model.js";

export type FactStratum = "A" | "B" | "C" | "E";
export type SessionStratum = "C" | "D" | "E";

const DEPENDENCY_VERB = /\b(?:install(?:s|ed|ing)?|depend(?:s|ed|ing|ency|encies)?(?:\s+on)?|require[sd]?|import(?:s|ed)?|plugin)\b/i;
const NAMESPACE_TOKEN = /(?:[\w.-]*\/[\w./-]+|\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}\b|:\d{2,5}\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b)/g;
const EVAL_WORK = /\b(?:eval(?:uation)?|label(?:l?ing)?|review|replay)\b/i;
const NEAR = 40;

function names(property: MemoryProperty): string[] {
  return [property.label, ...property.aliases, property.slug];
}
function literal(name: string): RegExp {
  const parts = name.trim().split(/[\s_-]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}_])${parts.join("[\\s_-]+")}(?![\\p{L}\\p{N}_])`, "giu");
}
export function mentions(text: string, catalog: readonly MemoryProperty[]): { slug: string; at: number; length: number }[] {
  const found: { slug: string; at: number; length: number }[] = [];
  for (const p of catalog) for (const n of names(p)) for (const m of text.matchAll(literal(n))) found.push({ slug: p.slug, at: m.index!, length: m[0].length });
  return found;
}

export function namesDependencyOrSeveral(text: string, catalog: readonly MemoryProperty[]): boolean {
  const hits = mentions(text, catalog);
  if (new Set(hits.map((h) => h.slug)).size >= 2) return true;
  return hits.some((h) => DEPENDENCY_VERB.test(text.slice(Math.max(0, h.at - NEAR), h.at + h.length + NEAR)));
}

export function namesRuntimeNamespace(text: string, catalog: readonly MemoryProperty[]): boolean {
  return mentions(text, catalog).some((h) => {
    const window = text.slice(Math.max(0, h.at - NEAR), h.at + h.length + NEAR);
    return [...window.matchAll(NAMESPACE_TOKEN)].some((m) => m[0].toLowerCase() !== text.slice(h.at, h.at + h.length).toLowerCase());
  });
}

export function quotesEvaluationInput(session: { skill: string | null; label: string; body: string }): boolean {
  if (EVAL_WORK.test(session.skill ?? "") || EVAL_WORK.test(session.label)) return true;
  return [...session.body.matchAll(/```[\s\S]*?```/g)].some((m) => /\[(?:user|assistant|human)\]|\bsess(?:ion)?_[\w-]+/i.test(m[0]));
}

export interface FactSource { readonly quote: string | null; readonly value: string; readonly session: { skill: string | null; label: string; body: string } }

/** Every matching stratum in table order; E always matches last. */
export function factMatches(source: FactSource, catalog: readonly MemoryProperty[]): FactStratum[] {
  const text = `${source.quote ?? ""}\n${source.value}`;
  const matches: FactStratum[] = [];
  if (namesDependencyOrSeveral(source.quote ?? source.value, catalog)) matches.push("A");
  if (namesRuntimeNamespace(text, catalog)) matches.push("B");
  if (quotesEvaluationInput(source.session)) matches.push("C");
  return [...matches, "E"];
}
/** First matching row in table order wins. */
export const classifyFact = (source: FactSource, catalog: readonly MemoryProperty[]): FactStratum => factMatches(source, catalog)[0]!;

export interface SessionSource { readonly session: { skill: string | null; label: string; body: string }; readonly hasRepositoryOrExplicit: boolean }

/** Session table order: C, D, E. D requires catalog entities (the caller only classifies sessions that have them). */
export function sessionMatches(source: SessionSource): SessionStratum[] {
  const matches: SessionStratum[] = [];
  if (quotesEvaluationInput(source.session)) matches.push("C");
  if (!source.hasRepositoryOrExplicit) matches.push("D");
  return [...matches, "E"];
}
export const classifySession = (source: SessionSource): SessionStratum => sessionMatches(source)[0]!;
