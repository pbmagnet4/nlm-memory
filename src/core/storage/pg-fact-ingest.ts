import { PgPropertyStore } from "./pg-property-store.js";
import { propertyValues } from "./property-attribution.js";
/**
 * Single source of truth for pg fact-ingest. Caller owns the transaction:
 * this function MUST run on a client that already issued BEGIN.
 *
 * Mirrors SqliteFactStore.ingestSessionFactsInTxn semantics (NLM #351):
 *  - re-ingest clears prior facts for the session (fact_embeddings rows for
 *    DELETED facts self-clean via the FK ON DELETE CASCADE; UPDATE-superseded
 *    facts below need an explicit embedding delete)
 *  - one winner per (subject, predicate) per batch (last in batch wins), so an
 *    intra-batch duplicate can never create a mutual supersedence cycle
 *  - every fact the collapse supersedes leaves the ANN index immediately
 */

import { anchorValues } from "./fact-source-anchor.js";
import { persistedText } from "@core/context/source-version.js";
import type { PoolClient } from "pg";
import type { Fact } from "@shared/types.js";
import { collapseWinners } from "./fact-batch.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

export async function ingestSessionFactsOnClient(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
  facts: ReadonlyArray<Fact>,
  scope: string | null = null,
): Promise<void> {
  facts = await new PgPropertyStore(client).prepareFacts(tenantId, sessionId, facts);
  const deleteTc = tenantClausePg(tenantId, 2);
  await client.query(`DELETE FROM facts WHERE source_session_id = $1 AND ${deleteTc.sql}`, [sessionId, deleteTc.param]);
  if (facts.length === 0) return;

  for (const f of facts) {
    await client.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence, retired_at, scope, tenant_id, source_start, source_end, source_body_version, source_quote_status, property_slug, property_source, property_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [f.id, f.kind, f.subject, f.predicate, f.value, f.sourceSessionId,
       f.sourceQuote === null ? null : persistedText(f.sourceQuote), f.createdAt, f.supersededBy, f.confidence, f.retiredAt, scope, tenantId, ...anchorValues(f.sourceAnchor), ...propertyValues(f.property)],
    );
  }

  for (const f of collapseWinners(facts)) {
    const collapseTc = tenantClausePg(tenantId, 4);
    const collapsed = await client.query<{ id: string }>(
      `UPDATE facts SET superseded_by = $1
       WHERE subject = $2 AND predicate = $3 AND superseded_by IS NULL AND id != $1 AND property_slug IS NOT DISTINCT FROM $5 AND ${collapseTc.sql}
       RETURNING id`,
      [f.id, f.subject, f.predicate, collapseTc.param, f.property?.slug ?? null],
    );
    const ids = collapsed.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [ids]);
    }
  }
}
