import { repositoryProperty } from "@core/properties/repository.js";
import { validateSourceAnchor } from "@core/facts/source-anchor.js";
import type Database from "better-sqlite3";
import type { Fact } from "@shared/types.js";
import type { PropertyBackfillRow, PropertyStore } from "@ports/property-store.js";
import { assertionKey, attributeFacts, attributeFactGroups, sessionPropertyReferences, parseProperties, propertyAssociationsEnabled, propertyInferenceEnabled, type MemoryProperty, type PropertyOverride } from "@core/properties/model.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { anchorFromRow } from "./fact-source-anchor.js";
import { sourceIdentityExpression, propertyFromRow, type PropertyRow } from "./property-attribution.js";

type StoredFact = PropertyRow & { id: string; kind: Fact["kind"]; subject: string; predicate: string; value: string; source_session_id: string;
  source_quote: string | null; created_at: string; superseded_by: string | null; confidence: number; source_identity: string; source_status: string;
  source_start: number | null; source_end: number | null; source_body_version: string | null; source_quote_status: string | null; current_source_body_version: string | null };
function toFact(r: StoredFact): Fact {
  return { id: r.id, kind: r.kind, subject: r.subject, predicate: r.predicate, value: r.value, sourceSessionId: r.source_session_id,
    sourceQuote: r.source_quote, createdAt: r.created_at, supersededBy: r.superseded_by, confidence: r.confidence,
    property: propertyFromRow(r), sourceAnchor: anchorFromRow(r, r.source_quote) };
}
export class SqlitePropertyStore implements PropertyStore {
  constructor(private readonly db: Database.Database) {}
  listSync(tenantId: string): MemoryProperty[] {
    const tc = tenantClause(tenantId);
    return this.db.prepare<[string], { slug: string; label: string; aliases: string; repositories: string }>(`SELECT * FROM memory_properties WHERE ${tc.sql} ORDER BY slug`).all(tc.param)
      .map((r) => ({ slug: r.slug, label: r.label, aliases: JSON.parse(r.aliases) as string[], repositories: JSON.parse(r.repositories) as string[] }));
  }
  async list(tenantId: string): Promise<MemoryProperty[]> { return this.listSync(tenantId); }
  async import(tenantId: string, input: unknown): Promise<void> {
    const incoming = parseProperties(input);
    this.db.transaction(() => {
      parseProperties([...this.listSync(tenantId).filter((p) => !incoming.some((i) => i.slug === p.slug)), ...incoming]);
      const stmt = this.db.prepare(`INSERT INTO memory_properties (tenant_id, slug, label, aliases, repositories) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, slug) DO UPDATE SET label = excluded.label, aliases = excluded.aliases, repositories = excluded.repositories`);
      for (const p of incoming) stmt.run(tenantId, p.slug, p.label, JSON.stringify(p.aliases), JSON.stringify(p.repositories));
    })();
  }
  private rows(tenantId: string, sessionId?: string): StoredFact[] {
    const ft = tenantClause(tenantId, "f.tenant_id");
    const st = tenantClause(tenantId, "s.tenant_id");
    return this.db.prepare<unknown[], StoredFact>(`SELECT f.*, ${sourceIdentityExpression("s")} AS source_identity,
      s.status AS source_status, s.body_version AS current_source_body_version FROM facts f JOIN sessions s ON s.id = f.source_session_id
      WHERE ${ft.sql} AND ${st.sql} ${sessionId ? "AND s.id = ?" : ""} ORDER BY f.id`).all(ft.param, st.param, ...(sessionId ? [sessionId] : []));
  }
  private overrides(tenantId: string, sourceIdentity?: string): PropertyOverride[] {
    const tc = tenantClause(tenantId);
    return this.db.prepare<unknown[], { source_identity: string; assertion_key: string; property_slug: string | null }>(`SELECT source_identity, assertion_key, property_slug FROM property_overrides WHERE ${tc.sql} ${sourceIdentity ? "AND source_identity = ?" : ""}`)
      .all(tc.param, ...(sourceIdentity ? [sourceIdentity] : [])).map((r) => ({ sourceIdentity: r.source_identity, assertionKey: r.assertion_key, slug: r.property_slug }));
  }
  prepareFacts(tenantId: string, sessionId: string, facts: readonly Fact[]): Fact[] {
    const tc = tenantClause(tenantId);
    const session = this.db.prepare<[string, string], { source_identity: string; body_version: string | null }>(`SELECT ${sourceIdentityExpression()} AS source_identity, body_version FROM sessions WHERE id = ? AND ${tc.sql}`).get(sessionId, tc.param);
    if (!session) throw new Error("Source session not found");
    const overrides = this.overrides(tenantId, session.source_identity);
    const prior = new Map(this.rows(tenantId, sessionId).filter((r) => r.property_source !== "operator" && r.source_body_version === session.body_version).map((r) => [assertionKey(toFact(r), session.body_version), propertyFromRow(r)]));
    const restored = facts.map((f) => ({ ...f, sourceAnchor: validateSourceAnchor(f.sourceAnchor, session.body_version), property: f.property ?? prior.get(assertionKey(f, session.body_version)) }));
    return attributeFacts(restored, this.listSync(tenantId), overrides, propertyAssociationsEnabled() && propertyInferenceEnabled(), session.body_version);
  }
  attributeSession(tenantId: string, record: { id: string; entities: readonly string[]; projectDir?: string }): void {
    const tc = tenantClause(tenantId);
    if (!this.db.prepare(`SELECT id FROM sessions WHERE id = ? AND ${tc.sql}`).get(record.id, tc.param)) throw new Error("Source session not found");
    this.db.prepare(`DELETE FROM session_properties WHERE session_id = ? AND source IN ('entity', 'repository') AND ${tc.sql}`).run(record.id, tc.param);
    if (!propertyAssociationsEnabled()) return;
    const origin = repositoryProperty(record.projectDir, this.listSync(tenantId));
    if (origin) this.db.prepare("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES (?, ?, ?, 'repository', ?)").run(tenantId, record.id, origin, record.projectDir!);
    for (const p of sessionPropertyReferences(propertyInferenceEnabled() ? record.entities : [], this.listSync(tenantId))) {
      this.db.prepare("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES (?, ?, ?, 'entity', ?)").run(tenantId, record.id, p.slug, p.evidence);
    }
  }
  async associateSession(tenantId: string, sessionId: string, slugs: readonly string[]): Promise<void> {
    this.db.transaction(() => {
      const tc = tenantClause(tenantId);
      if (!this.db.prepare(`SELECT id FROM sessions WHERE id = ? AND ${tc.sql}`).get(sessionId, tc.param)) throw new Error("Source session not found");
      const catalog = this.listSync(tenantId);
      for (const slug of slugs) if (!catalog.some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
      this.db.prepare(`DELETE FROM session_properties WHERE session_id = ? AND source = 'operator' AND ${tc.sql}`).run(sessionId, tc.param);
      for (const slug of new Set(slugs)) this.db.prepare("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES (?, ?, ?, 'operator', 'Explicit session association')").run(tenantId, sessionId, slug);
    })();
  }
  async correctFact(tenantId: string, factId: string, slug: string | null): Promise<void> {
    this.db.transaction(() => {
      if (slug !== null && !this.listSync(tenantId).some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
      const rows = this.rows(tenantId);
      const row = rows.find((r) => r.id === factId);
      if (!row) throw new Error("Fact not found");
      const key = assertionKey(toFact(row), row.current_source_body_version);
      const matches = rows.filter((r) => r.source_identity === row.source_identity && assertionKey(toFact(r), r.current_source_body_version) === key);
      const counts = new Map<string, number>(); for (const r of matches) counts.set(r.source_session_id, (counts.get(r.source_session_id) ?? 0) + 1);
      if ([...counts.values()].some((n) => n > 1)) throw new Error("Ambiguous duplicate assertion");
      this.db.prepare(`INSERT INTO property_overrides (tenant_id, source_identity, assertion_key, property_slug) VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_id, source_identity, assertion_key) DO UPDATE SET property_slug = excluded.property_slug`).run(tenantId, row.source_identity, key, slug);
      const tc = tenantClause(tenantId);
      for (const r of matches) this.db.prepare(`UPDATE facts SET property_slug = ?, property_source = 'operator', property_evidence = ? WHERE id = ? AND ${tc.sql}`)
        .run(slug, "Exact source identity and normalized assertion", r.id, tc.param);
    })();
  }
  async backfill(tenantId: string, apply: boolean): Promise<PropertyBackfillRow[]> {
    if (!propertyInferenceEnabled()) throw new Error("Automatic property inference has not passed activation evaluation; backfill requires NLM_PROPERTY_INFERENCE=1");
    return this.db.transaction(() => {
      const catalog = this.listSync(tenantId);
      const tc = tenantClause(tenantId);
      const rows = this.rows(tenantId);
      const attributed = attributeFactGroups(rows.map((r) => ({ fact: toFact(r), sourceIdentity: r.source_identity, sourceVersion: r.current_source_body_version })), catalog, this.overrides(tenantId));
      const changes: PropertyBackfillRow[] = rows.filter((r) => r.property_source !== "operator").flatMap((r) => {
        const f = attributed.get(r.id)!;
        if ((f.property?.slug ?? null) === r.property_slug && (f.property?.source ?? null) === r.property_source && (f.property?.evidence ?? null) === r.property_evidence) return [];
        if (apply) this.db.prepare(`UPDATE facts SET property_slug = ?, property_source = ?, property_evidence = ? WHERE id = ? AND ${tc.sql}`)
          .run(f.property?.slug ?? null, f.property?.source ?? null, f.property?.evidence ?? null, f.id, tc.param);
        return [{ factId: f.id, slug: f.property?.slug ?? null, source: f.property?.source ?? null }];
      });
      const entities = this.db.prepare<[string], { session_id: string; entity_canonical: string }>(`SELECT session_id, entity_canonical FROM session_entities WHERE ${tc.sql}`).all(tc.param);
      const bySession = new Map<string, string[]>();
      for (const e of entities) bySession.set(e.session_id, [...(bySession.get(e.session_id) ?? []), e.entity_canonical]);
      for (const [sessionId, names] of bySession) for (const p of sessionPropertyReferences(names, catalog)) {
        const exists = this.db.prepare(`SELECT 1 FROM session_properties WHERE session_id = ? AND property_slug = ? AND ${tc.sql}`).get(sessionId, p.slug, tc.param);
        if (exists) continue;
        if (apply) this.db.prepare("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES (?, ?, ?, 'entity', ?)").run(tenantId, sessionId, p.slug, p.evidence);
        changes.push({ sessionId, slug: p.slug, source: "entity" });
      }
      return changes;
    })();
  }
  async pendingCorrections(tenantId: string): Promise<{ sourceIdentity: string; assertionKey: string }[]> {
    const rows = this.rows(tenantId);
    const found = new Set(rows.filter((r) => r.source_status !== "replaced" && r.property_source === "operator").map((r) => `${r.source_identity}/${assertionKey(toFact(r), r.current_source_body_version)}`));
    const tc = tenantClause(tenantId);
    return this.db.prepare<[string], { source_identity: string; assertion_key: string }>(`SELECT source_identity, assertion_key FROM property_overrides WHERE ${tc.sql}`).all(tc.param)
      .filter((r) => !found.has(`${r.source_identity}/${r.assertion_key}`)).map((r) => ({ sourceIdentity: r.source_identity, assertionKey: r.assertion_key }));
  }
}
