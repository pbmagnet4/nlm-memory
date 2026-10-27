import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Command } from "commander";
import { attributeFacts, parseProperties, sessionPropertyReferences } from "../../src/core/properties/model.js";
import { anchorFromRow, type SourceAnchorRow } from "../../src/core/storage/fact-source-anchor.js";
import { tenantClause } from "../../src/core/tenancy/tenant-clause.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import type { Fact } from "../../src/shared/types.js";

new Command().argument("<database>").argument("<catalog>").option("--tenant <id>", "Tenant to evaluate", DEFAULT_TEAM_ID)
  .action((path: string, catalogPath: string, options: { tenant: string }) => {
    const catalog = parseProperties(JSON.parse(readFileSync(catalogPath, "utf8")));
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const ft = tenantClause(options.tenant, "f.tenant_id"); const st = tenantClause(options.tenant, "s.tenant_id");
      const columns = new Set((db.pragma("table_info(facts)") as { name: string }[]).map((r) => r.name));
      const hasAnchors = columns.has("source_quote_status");
      const anchors = hasAnchors ? "f.source_start, f.source_end, f.source_body_version, f.source_quote_status, s.body_version AS current_source_body_version"
        : "NULL AS source_start, NULL AS source_end, NULL AS source_body_version, NULL AS source_quote_status, NULL AS current_source_body_version";
      const rows = db.prepare<unknown[], SourceAnchorRow & {
        id: string; kind: Fact["kind"]; subject: string; predicate: string; value: string; source_session_id: string; source_quote: string | null; created_at: string; confidence: number;
      }>(`SELECT f.id, f.kind, f.subject, f.predicate, f.value, f.source_session_id, f.source_quote, f.created_at, f.confidence, ${anchors}
        FROM facts f JOIN sessions s ON s.id = f.source_session_id WHERE ${ft.sql} AND ${st.sql} AND f.superseded_by IS NULL AND f.retired_at IS NULL`).all(ft.param, st.param);
      const proposed = attributeFacts(rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, predicate: r.predicate, value: r.value,
        sourceSessionId: r.source_session_id, sourceQuote: r.source_quote, createdAt: r.created_at, confidence: r.confidence, supersededBy: null,
        sourceAnchor: anchorFromRow(r, r.source_quote) })), catalog, []);
      const bySource: Record<string, number> = {}; const byProperty: Record<string, number> = {};
      for (const f of proposed) if (f.property?.slug) { bySource[f.property.source] = (bySource[f.property.source] ?? 0) + 1; byProperty[f.property.slug] = (byProperty[f.property.slug] ?? 0) + 1; }
      const entities = db.prepare<[string], { session_id: string; entity_canonical: string }>(`SELECT session_id, entity_canonical FROM session_entities WHERE ${tenantClause(options.tenant).sql}`).all(options.tenant);
      const groups = new Map<string, string[]>();
      for (const e of entities) groups.set(e.session_id, [...(groups.get(e.session_id) ?? []), e.entity_canonical]);
      const references = [...groups.values()].map((names) => sessionPropertyReferences(names, catalog));
      const totalSessions = db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM sessions WHERE ${tenantClause(options.tenant).sql}`).get(options.tenant)!.n;
      console.log(JSON.stringify({ evaluatedAt: new Date().toISOString(), readonly: true, catalogSize: catalog.length,
        activeFacts: proposed.length, proposedFactAssociations: proposed.filter((f) => f.property?.slug).length,
        unresolvedFacts: proposed.filter((f) => !f.property?.slug).length, bySource, byProperty, sourceAnchorColumnsPresent: hasAnchors,
        totalSessions, sessionsWithEntityReferences: references.filter((r) => r.length).length, multiPropertySessions: references.filter((r) => r.length > 1).length,
        precisionEvaluated: false }, null, 2));
    } finally { db.close(); }
  }).parse();
