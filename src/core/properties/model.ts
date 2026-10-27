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
function namesProperty(quote: string, name: string): boolean {
  const literal = name.trim().split(/[\s_-]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+");
  // Runtime paths, code identifiers and reverse-DNS namespaces are not ownership evidence.
  return new RegExp(`(^|[^\\p{L}\\p{N}_./:@-])${literal}(?=$|[^\\p{L}\\p{N}_./:@-])`, "iu").test(quote);
}
export function attributeFacts(facts: readonly Fact[], properties: readonly MemoryProperty[], overrides: readonly PropertyOverride[], infer = true, sourceVersion?: string | null): Fact[] {
  const corrections = new Map(overrides.map((o) => [o.assertionKey, o]));
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(assertionKey(f, sourceVersion), (counts.get(assertionKey(f, sourceVersion)) ?? 0) + 1);
  return facts.map((fact) => {
    const correction = corrections.get(assertionKey(fact, sourceVersion));
    if (correction && counts.get(assertionKey(fact, sourceVersion)) !== 1) return { ...fact, property: undefined };
    if (correction) return { ...fact, property: { slug: correction.slug, source: "operator", evidence: "Exact source identity and normalized assertion" } };
    if (fact.property?.source === "explicit" || fact.property?.source === "operator") {
      if (fact.property.slug !== null && !properties.some((p) => p.slug === fact.property!.slug)) throw new Error(`Unknown property: ${fact.property.slug}`);
      return fact;
    }
    if (!infer) return { ...fact, property: undefined };
    const subject = properties.filter((p) => [p.slug, p.label, ...p.aliases].some((a) => normalizeName(a) === normalizeName(fact.subject)));
    if (fact.sourceAnchor?.status === "verified" && fact.sourceQuote) {
      const matches = properties.filter((p) => [p.label, ...p.aliases].some((a) => namesProperty(fact.sourceQuote!, a)));
      if (matches.length === 1 && (subject.length === 0 || subject[0]!.slug === matches[0]!.slug)) {
        return { ...fact, property: { slug: matches[0]!.slug, source: subject.length === 1 ? "subject" : "source-quote", evidence: fact.sourceQuote } };
      }
    }
    return { ...fact, property: undefined };
  });
}

export async function requireProperty(tenantId: string, slug: string | undefined, store?: { list(tenantId: string): Promise<readonly MemoryProperty[]> }): Promise<void> {
  if (slug === undefined) return;
  propertySchema.shape.slug.parse(slug);
  if (!store || !(await store.list(tenantId)).some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
}

export function sessionPropertyReferences(entities: readonly string[], catalog: readonly MemoryProperty[]): { slug: string; evidence: string }[] {
  return catalog.flatMap((p) => {
    const evidence = entities.find((e) => [p.slug, p.label, ...p.aliases].some((a) => normalizeName(a) === normalizeName(e)));
    return evidence ? [{ slug: p.slug, evidence }] : [];
  });
}

export function attributeFactGroups(rows: readonly { fact: Fact; sourceIdentity: string; sourceVersion: string | null }[], catalog: readonly MemoryProperty[], overrides: readonly PropertyOverride[]): Map<string, Fact> {
  const bySource = new Map<string, PropertyOverride[]>();
  for (const o of overrides) bySource.set(o.sourceIdentity, [...(bySource.get(o.sourceIdentity) ?? []), o]);
  const groups = new Map<string, { facts: Fact[]; sourceIdentity: string; sourceVersion: string | null }>();
  for (const row of rows) {
    const group = groups.get(row.fact.sourceSessionId) ?? { facts: [], sourceIdentity: row.sourceIdentity, sourceVersion: row.sourceVersion };
    group.facts.push(row.fact); groups.set(row.fact.sourceSessionId, group);
  }
  const result = new Map<string, Fact>();
  for (const group of groups.values()) for (const f of attributeFacts(group.facts, catalog, bySource.get(group.sourceIdentity) ?? [], true, group.sourceVersion)) result.set(f.id, f);
  return result;
}
