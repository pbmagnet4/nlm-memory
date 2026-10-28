import { createHash } from "node:crypto";
import { z } from "zod";
import type { Fact } from "@shared/types.js";

export const propertySlug = z.string().max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const propertySchema = z.object({
  slug: propertySlug,
  label: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  repositories: z.array(z.string().trim().min(1)).default([]),
});
export type MemoryProperty = z.infer<typeof propertySchema>;
export type PropertySource = "subject" | "source-quote" | "explicit" | "operator";
export interface PropertyAttribution { readonly slug: string | null; readonly source: PropertySource; readonly evidence: string }
export interface PropertyOverride { readonly sourceIdentity: string; readonly assertionKey: string; readonly slug: string | null }
export function normalizeName(value: string): string { return value.trim().toLowerCase().replace(/[\s_-]+/g, " "); }
export function parseProperties(input: unknown): MemoryProperty[] {
  const properties = z.array(propertySchema).parse(input);
  const seen = new Map<string, string>();
  for (const p of properties) {
    for (const alias of [p.slug, p.label, ...p.aliases]) {
      const key = normalizeName(alias);
      const previous = seen.get(key);
      if (previous && previous !== p.slug) throw new Error(`Ambiguous property alias: ${alias}`);
      seen.set(key, p.slug);
    }
  }
  if (new Set(properties.map((p) => p.slug)).size !== properties.length) throw new Error("Duplicate property slug");
  return properties;
}
export function assertionKey(fact: Pick<Fact, "kind" | "subject" | "predicate" | "value"> & Partial<Pick<Fact, "sourceQuote">>, sourceVersion?: string | null): string {
  return createHash("sha256").update(JSON.stringify([fact.kind, fact.subject, fact.predicate, fact.value, fact.sourceQuote ?? sourceVersion ?? ""]
    .map((s) => s.normalize("NFC").trim().replace(/\s+/g, " ")))).digest("hex");
}
export function propertyAssociationsEnabled(): boolean { return process.env["NLM_PROPERTY_ASSOCIATIONS"] === "1"; }
export function propertyInferenceEnabled(): boolean { return process.env["NLM_PROPERTY_INFERENCE"] === "1"; }
export function sessionPropertyInferenceEnabled(): boolean { return process.env["NLM_SESSION_PROPERTY_INFERENCE"] === "1"; }
interface TextSpan { readonly start: number; readonly end: number }
const QUOTED_BLOCK_TAGS = "environment_context|environment_details|INSTRUCTIONS|user_instructions|system-reminder";
const PREAMBLE_TURN = new RegExp(`^\\s*(?:#\\s*)?(?:AGENTS|CLAUDE)\\.md|^\\s*Contents of [^\\n]*(?:AGENTS|CLAUDE)\\.md|^\\s*<(?:${QUOTED_BLOCK_TAGS})>`, "i");
const TAGGED_BLOCK = new RegExp(`<(${QUOTED_BLOCK_TAGS})>[\\s\\S]*?(?:<\\/\\1>|$)`, "gi");
/** Regions of a transcript body that quote other material: fenced and block-quoted text, tool output, system and AGENTS/CLAUDE preamble turns, environment listings. */
function quotedRegions(body: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const turns = [...body.matchAll(/(?:^|\n\n)\[(user|human|assistant|system|tool)\] /gi)];
  turns.forEach((turn, i) => {
    const end = turns[i + 1]?.index ?? body.length;
    if (turn[1]!.toLowerCase() === "system" || PREAMBLE_TURN.test(body.slice(turn.index + turn[0].length, end))) spans.push({ start: turn.index, end });
  });
  for (const block of body.matchAll(TAGGED_BLOCK)) spans.push({ start: block.index, end: block.index + block[0].length });
  // Adapters render tool output inline; a result preview can span lines and contain brackets, so it runs to the end of its turn.
  for (const result of body.matchAll(/\[tool_result:/g)) spans.push({ start: result.index, end: turns.find((t) => t.index > result.index)?.index ?? body.length });
  for (const call of body.matchAll(/\[tool_(?:use|action):[^\n]*/g)) spans.push({ start: call.index, end: call.index + call[0].length });
  let fence: { marker: string; start: number } | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const end = offset + line.length;
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker !== undefined && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) { spans.push({ start: fence.start, end }); fence = null; }
    } else if (marker) fence = { marker, start: offset };
    else if (/^[ \t]*>/.test(line)) spans.push({ start: offset, end });
    offset = end + 1;
  }
  if (fence) spans.push({ start: fence.start, end: body.length });
  return spans;
}
const overlaps = (start: number, end: number, spans: readonly TextSpan[]) => spans.some((s) => start < s.end && end > s.start);
function nameOccurrences(text: string, name: string): TextSpan[] {
  const literal = name.trim().split(/[\s_-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+");
  // Runtime paths, code identifiers and reverse-DNS namespaces are not ownership evidence.
  return [...text.matchAll(new RegExp(`(^|[^\\p{L}\\p{N}_./:@-])(${literal})(?=$|[^\\p{L}\\p{N}_./:@-])`, "giu"))]
    .map((m) => ({ start: m.index + m[1]!.length, end: m.index + m[1]!.length + m[2]!.length }));
}
// A named product next to one of these is usually a dependency of the owner, not the owner.
const DEPENDENCY = /\b(?:(?:un)?install\w*|depend\w*|requir\w*|import\w*|plug-?ins?|bundl\w*|vendor\w*|embed\w*|librar(?:y|ies)|packag\w*|extensions?|integrat\w*|sdks?|clients?|wrap(?:s|ped|per|ping)?|consum\w*|via|needs?|rel(?:y|ies|ied) on|built on|powered by|ships? with|connect\w* to|talks? to|calls?|must have)\b/i;
const RUNTIME_TOKEN = new RegExp([
  String.raw`[a-z][a-z0-9+.-]*:\/\/\S+`, String.raw`[\w.-]*:\d{2,5}\b`, String.raw`(?:~|\.{1,2})?\/[\w.@~-]+`, String.raw`[\w.@~-]+\/[\w.@~-]+(?:\/|\.\w+)`,
  String.raw`\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}\b`, String.raw`\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b`, String.raw`\b[a-z0-9]+_[a-z0-9_]+\b`, String.raw`\b[a-z]+[A-Z]\w*`,
  String.raw`\b\w+\(\)`, "`[^`]+`",
].join("|"), "g");
const RUNTIME_WINDOW = 40;
function nearRuntimeToken(text: string, names: readonly string[]): boolean {
  const tokens = [...text.matchAll(RUNTIME_TOKEN)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  return names.some((n) => nameOccurrences(text, n).some((o) => overlaps(o.start - RUNTIME_WINDOW, o.end + RUNTIME_WINDOW, tokens)));
}
const names = (p: MemoryProperty) => [p.label, ...p.aliases];
const exactlyNames = (p: MemoryProperty, value: string) => [p.slug, ...names(p)].some((a) => normalizeName(a) === normalizeName(value));
/** Owner from a verified quote only when exactly one catalog property is named, outside quoted regions, with no dependency or runtime-namespace context. */
function quoteOwner(fact: Fact, properties: readonly MemoryProperty[], quoted: readonly TextSpan[] | null): PropertyAttribution | undefined {
  const quote = fact.sourceQuote;
  if (fact.sourceAnchor?.status !== "verified" || !quote || quoted === null || overlaps(fact.sourceAnchor.start, fact.sourceAnchor.end, quoted)) return undefined;
  const named = properties.filter((p) => names(p).some((a) => nameOccurrences(quote, a).length > 0 || nameOccurrences(fact.value, a).length > 0));
  if (named.length !== 1) return undefined;
  const owner = named[0]!;
  if (properties.some((p) => p.slug !== owner.slug && exactlyNames(p, fact.subject))) return undefined;
  if (DEPENDENCY.test(quote) || nearRuntimeToken(quote, names(owner)) || nearRuntimeToken(fact.value, names(owner))) return undefined;
  return { slug: owner.slug, source: "source-quote", evidence: quote };
}
export function attributeFacts(facts: readonly Fact[], properties: readonly MemoryProperty[], overrides: readonly PropertyOverride[], infer = true, sourceVersion?: string | null, body?: string | null): Fact[] {
  const corrections = new Map(overrides.map((o) => [o.assertionKey, o]));
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(assertionKey(f, sourceVersion), (counts.get(assertionKey(f, sourceVersion)) ?? 0) + 1);
  const quoted = infer && body != null ? quotedRegions(body) : null;
  return facts.map((fact) => {
    const correction = corrections.get(assertionKey(fact, sourceVersion));
    if (correction && counts.get(assertionKey(fact, sourceVersion)) !== 1) return { ...fact, property: undefined };
    if (correction) return { ...fact, property: { slug: correction.slug, source: "operator", evidence: "Exact source identity and normalized assertion" } };
    if (fact.property?.source === "explicit" || fact.property?.source === "operator") {
      if (fact.property.slug !== null && !properties.some((p) => p.slug === fact.property!.slug)) throw new Error(`Unknown property: ${fact.property.slug}`);
      return fact;
    }
    return { ...fact, property: infer ? quoteOwner(fact, properties, quoted) : undefined };
  });
}

export async function requireProperty(tenantId: string, slug: string | undefined, store?: { list(tenantId: string): Promise<readonly MemoryProperty[]> }): Promise<void> {
  if (slug === undefined) return;
  propertySchema.shape.slug.parse(slug);
  if (!store || !(await store.list(tenantId)).some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
}

/** Entity references whose name also appears in the session body outside quoted regions. */
export function sessionPropertyReferences(entities: readonly string[], catalog: readonly MemoryProperty[], body: string | null): { slug: string; evidence: string }[] {
  if (body === null) return [];
  const quoted = quotedRegions(body);
  return catalog.flatMap((p) => {
    const evidence = entities.find((e) => exactlyNames(p, e));
    if (!evidence) return [];
    const grounded = [p.slug, ...names(p)].some((n) => nameOccurrences(body, n).some((o) => !overlaps(o.start, o.end, quoted)));
    return grounded ? [{ slug: p.slug, evidence }] : [];
  });
}

export function attributeFactGroups(rows: readonly { fact: Fact; sourceIdentity: string; sourceVersion: string | null; body: string | null }[], catalog: readonly MemoryProperty[], overrides: readonly PropertyOverride[]): Map<string, Fact> {
  const bySource = new Map<string, PropertyOverride[]>();
  for (const o of overrides) bySource.set(o.sourceIdentity, [...(bySource.get(o.sourceIdentity) ?? []), o]);
  const groups = new Map<string, { facts: Fact[]; sourceIdentity: string; sourceVersion: string | null; body: string | null }>();
  for (const row of rows) {
    const group = groups.get(row.fact.sourceSessionId) ?? { facts: [], sourceIdentity: row.sourceIdentity, sourceVersion: row.sourceVersion, body: row.body };
    group.facts.push(row.fact); groups.set(row.fact.sourceSessionId, group);
  }
  const result = new Map<string, Fact>();
  for (const group of groups.values()) for (const f of attributeFacts(group.facts, catalog, bySource.get(group.sourceIdentity) ?? [], true, group.sourceVersion, group.body)) result.set(f.id, f);
  return result;
}
