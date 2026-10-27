import { repositoryProperty } from "@core/properties/repository.js";
import { validateSourceAnchor } from "@core/facts/source-anchor.js";
import { Pool, type PoolClient } from "pg";
import type { Fact } from "@shared/types.js";
import type { PropertyBackfillRow, PropertyStore } from "@ports/property-store.js";
import { assertionKey, attributeFacts, attributeFactGroups, sessionPropertyReferences, parseProperties, propertyAssociationsEnabled, propertyInferenceEnabled, type MemoryProperty, type PropertyOverride } from "@core/properties/model.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";
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
export class PgPropertyStore implements PropertyStore {
  constructor(private readonly db: Pool | PoolClient) {}
  private async atomic<T>(operation: (store: PgPropertyStore) => Promise<T>): Promise<T> {
    if (!(this.db instanceof Pool)) return operation(this);
    const client = await this.db.connect();
    try { await client.query("BEGIN"); const result = await operation(new PgPropertyStore(client)); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async list(tenantId: string): Promise<MemoryProperty[]> {
    const tc = tenantClausePg(tenantId, 1);
    const { rows } = await this.db.query<{ slug: string; label: string; aliases: string; repositories: string }>(`SELECT * FROM memory_properties WHERE ${tc.sql} ORDER BY slug`, [tc.param]);
    return rows.map((r) => ({ slug: r.slug, label: r.label, aliases: JSON.parse(r.aliases) as string[], repositories: JSON.parse(r.repositories) as string[] }));
  }
  async import(tenantId: string, input: unknown): Promise<void> {
    const incoming = parseProperties(input);
    await this.atomic(async (store) => {
      // Serialize catalog changes for the same tenant, including an initially empty catalog.
      await store.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`nlm-properties:${tenantId}`]);
      parseProperties([...(await store.list(tenantId)).filter((p) => !incoming.some((i) => i.slug === p.slug)), ...incoming]);
      for (const p of incoming) await store.db.query(`INSERT INTO memory_properties (tenant_id, slug, label, aliases, repositories) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, slug) DO UPDATE SET label = excluded.label, aliases = excluded.aliases, repositories = excluded.repositories`,
        [tenantId, p.slug, p.label, JSON.stringify(p.aliases), JSON.stringify(p.repositories)]);
    });
  }
  private async rows(tenantId: string, sessionId?: string): Promise<StoredFact[]> {
    const ft = tenantClausePg(tenantId, 1, "f.tenant_id"); const st = tenantClausePg(tenantId, 2, "s.tenant_id");
    const { rows } = await this.db.query<StoredFact>(`SELECT f.*, ${sourceIdentityExpression("s")} AS source_identity,
      s.status AS source_status, s.body_version AS current_source_body_version FROM facts f JOIN sessions s ON s.id = f.source_session_id
      WHERE ${ft.sql} AND ${st.sql} ${sessionId ? "AND s.id = $3" : ""} ORDER BY f.id`, [ft.param, st.param, ...(sessionId ? [sessionId] : [])]);
    return rows;
  }
  private async overrides(tenantId: string, sourceIdentity?: string): Promise<PropertyOverride[]> {
    const tc = tenantClausePg(tenantId, 1);
    const { rows } = await this.db.query<{ source_identity: string; assertion_key: string; property_slug: string | null }>(`SELECT source_identity, assertion_key, property_slug FROM property_overrides WHERE ${tc.sql} ${sourceIdentity ? "AND source_identity = $2" : ""}`, [tc.param, ...(sourceIdentity ? [sourceIdentity] : [])]);
    return rows.map((r) => ({ sourceIdentity: r.source_identity, assertionKey: r.assertion_key, slug: r.property_slug }));
  }
  async prepareFacts(tenantId: string, sessionId: string, facts: readonly Fact[]): Promise<Fact[]> {
    const tc = tenantClausePg(tenantId, 2);
    const { rows } = await this.db.query<{ source_identity: string; body_version: string | null }>(`SELECT ${sourceIdentityExpression()} AS source_identity, body_version FROM sessions WHERE id = $1 AND ${tc.sql}`, [sessionId, tc.param]);
    const session = rows[0]; if (!session) throw new Error("Source session not found");
    await this.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`nlm-property-source:${tenantId}:${session.source_identity}`]);
    const overrides = await this.overrides(tenantId, session.source_identity);
    const catalog = await this.list(tenantId);
    const prior = new Map((await this.rows(tenantId, sessionId)).filter((r) => r.property_source !== "operator" && r.source_body_version === session.body_version).map((r) => [assertionKey(toFact(r), session.body_version), propertyFromRow(r)]));
    const restored = facts.map((f) => ({ ...f, sourceAnchor: validateSourceAnchor(f.sourceAnchor, session.body_version), property: f.property ?? prior.get(assertionKey(f, session.body_version)) }));
    return attributeFacts(restored, catalog, overrides, propertyAssociationsEnabled() && propertyInferenceEnabled(), session.body_version);
  }
  async attributeSession(tenantId: string, record: { id: string; entities: readonly string[]; projectDir?: string }): Promise<void> {
    const tc = tenantClausePg(tenantId, 2);
    const owned = await this.db.query(`SELECT id FROM sessions WHERE id = $1 AND ${tc.sql}`, [record.id, tc.param]);
    if (!owned.rows.length) throw new Error("Source session not found");
    await this.db.query(`DELETE FROM session_properties WHERE session_id = $1 AND source IN ('entity', 'repository') AND ${tc.sql}`, [record.id, tc.param]);
    if (!propertyAssociationsEnabled()) return;
    const origin = repositoryProperty(record.projectDir, await this.list(tenantId));
    if (origin) await this.db.query("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES ($1, $2, $3, 'repository', $4)", [tenantId, record.id, origin, record.projectDir!]);
    for (const p of sessionPropertyReferences(propertyInferenceEnabled() ? record.entities : [], await this.list(tenantId))) {
      await this.db.query("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES ($1, $2, $3, 'entity', $4)", [tenantId, record.id, p.slug, p.evidence]);
    }
  }
  async associateSession(tenantId: string, sessionId: string, slugs: readonly string[]): Promise<void> {
    await this.atomic(async (store) => {
      const tc = tenantClausePg(tenantId, 2);
      const { rows } = await store.db.query(`SELECT id FROM sessions WHERE id = $1 AND ${tc.sql} FOR UPDATE`, [sessionId, tc.param]);
      if (!rows.length) throw new Error("Source session not found");
      const catalog = await store.list(tenantId);
      for (const slug of slugs) if (!catalog.some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
      await store.db.query(`DELETE FROM session_properties WHERE session_id = $1 AND source = 'operator' AND ${tc.sql}`, [sessionId, tc.param]);
      for (const slug of new Set(slugs)) await store.db.query("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES ($1, $2, $3, 'operator', 'Explicit session association')", [tenantId, sessionId, slug]);
    });
  }
  async correctFact(tenantId: string, factId: string, slug: string | null): Promise<void> {
    await this.atomic(async (store) => {
      if (slug !== null && !(await store.list(tenantId)).some((p) => p.slug === slug)) throw new Error(`Unknown property: ${slug}`);
      let rows = await store.rows(tenantId); const row = rows.find((r) => r.id === factId);
      if (!row) throw new Error("Fact not found");
      await store.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`nlm-property-source:${tenantId}:${row.source_identity}`]);
      rows = await store.rows(tenantId);
      const key = assertionKey(toFact(row), row.current_source_body_version);
      const matches = rows.filter((r) => r.source_identity === row.source_identity && assertionKey(toFact(r), r.current_source_body_version) === key);
      const counts = new Map<string, number>(); for (const r of matches) counts.set(r.source_session_id, (counts.get(r.source_session_id) ?? 0) + 1);
      if ([...counts.values()].some((n) => n > 1)) throw new Error("Ambiguous duplicate assertion");
      await store.db.query(`INSERT INTO property_overrides (tenant_id, source_identity, assertion_key, property_slug) VALUES ($1, $2, $3, $4)
        ON CONFLICT (tenant_id, source_identity, assertion_key) DO UPDATE SET property_slug = excluded.property_slug`, [tenantId, row.source_identity, key, slug]);
      const tc = tenantClausePg(tenantId, 4);
      for (const r of matches) await store.db.query(`UPDATE facts SET property_slug = $1, property_source = 'operator', property_evidence = $2 WHERE id = $3 AND ${tc.sql}`,
        [slug, "Exact source identity and normalized assertion", r.id, tc.param]);
    });
  }
  async backfill(tenantId: string, apply: boolean): Promise<PropertyBackfillRow[]> {
    if (!propertyInferenceEnabled()) throw new Error("Automatic property inference has not passed activation evaluation; backfill requires NLM_PROPERTY_INFERENCE=1");
    return this.atomic(async (store) => {
      const catalog = await store.list(tenantId); const tc = tenantClausePg(tenantId, 5); const results: PropertyBackfillRow[] = [];
      const rows = await store.rows(tenantId);
      const attributed = attributeFactGroups(rows.map((r) => ({ fact: toFact(r), sourceIdentity: r.source_identity, sourceVersion: r.current_source_body_version })), catalog, await store.overrides(tenantId));
      for (const r of rows) {
        if (r.property_source === "operator") continue;
        const f = attributed.get(r.id)!;
        if ((f.property?.slug ?? null) === r.property_slug && (f.property?.source ?? null) === r.property_source && (f.property?.evidence ?? null) === r.property_evidence) continue;
        if (apply) await store.db.query(`UPDATE facts SET property_slug = $1, property_source = $2, property_evidence = $3 WHERE id = $4 AND property_source IS DISTINCT FROM 'operator' AND ${tc.sql}`,
          [f.property?.slug ?? null, f.property?.source ?? null, f.property?.evidence ?? null, f.id, tc.param]);
        results.push({ factId: f.id, slug: f.property?.slug ?? null, source: f.property?.source ?? null });
      }
      const st = tenantClausePg(tenantId, 1);
      const { rows: entities } = await store.db.query<{ session_id: string; entity_canonical: string }>(`SELECT session_id, entity_canonical FROM session_entities WHERE ${st.sql}`, [st.param]);
      const bySession = new Map<string, string[]>();
      for (const e of entities) bySession.set(e.session_id, [...(bySession.get(e.session_id) ?? []), e.entity_canonical]);
      for (const [sessionId, names] of bySession) for (const p of sessionPropertyReferences(names, catalog)) {
        const check = tenantClausePg(tenantId, 3);
        const { rows } = await store.db.query(`SELECT 1 FROM session_properties WHERE session_id = $1 AND property_slug = $2 AND ${check.sql}`, [sessionId, p.slug, check.param]);
        if (rows.length) continue;
        if (apply) await store.db.query("INSERT INTO session_properties (tenant_id, session_id, property_slug, source, evidence) VALUES ($1, $2, $3, 'entity', $4) ON CONFLICT DO NOTHING", [tenantId, sessionId, p.slug, p.evidence]);
        results.push({ sessionId, slug: p.slug, source: "entity" });
      }
      return results;
    });
  }
  async pendingCorrections(tenantId: string): Promise<{ sourceIdentity: string; assertionKey: string }[]> {
    const found = new Set((await this.rows(tenantId)).filter((r) => r.source_status !== "replaced" && r.property_source === "operator").map((r) => `${r.source_identity}/${assertionKey(toFact(r), r.current_source_body_version)}`));
    const tc = tenantClausePg(tenantId, 1);
    const { rows } = await this.db.query<{ source_identity: string; assertion_key: string }>(`SELECT source_identity, assertion_key FROM property_overrides WHERE ${tc.sql}`, [tc.param]);
    return rows.filter((r) => !found.has(`${r.source_identity}/${r.assertion_key}`)).map((r) => ({ sourceIdentity: r.source_identity, assertionKey: r.assertion_key }));
  }
}
