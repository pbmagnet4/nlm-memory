import type { PropertyAttribution } from "@core/properties/model.js";
export const PROPERTY_COLUMNS = "property_slug, property_source, property_evidence";
export interface PropertyRow { property_slug: string | null; property_source: PropertyAttribution["source"] | null; property_evidence: string | null }
export function propertyFromRow(row: PropertyRow): PropertyAttribution | undefined {
  return row.property_source == null ? undefined : { slug: row.property_slug, source: row.property_source, evidence: row.property_evidence ?? "" };
}
export function propertyValues(property: PropertyAttribution | undefined): [string | null, string | null, string | null] {
  return [property?.slug ?? null, property?.source ?? null, property?.evidence ?? null];
}

export function sourceIdentityExpression(alias: "" | "s" = ""): string {
  const p = alias ? alias + "." : "";
  return `CAST(LENGTH(${p}runtime) AS TEXT) || ':' || ${p}runtime || ':' || CASE WHEN ${p}runtime_session_id IS NOT NULL AND ${p}runtime_session_id <> '' THEN 'runtime:' || ${p}runtime_session_id ELSE 'session:' || ${p}id END`;
}
