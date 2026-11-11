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
import { collapseWinners, collapses, newestFact } from "./fact-batch.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

export async function ingestSessionFactsOnClient(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
  facts: ReadonlyArray<Fact>,
  scope: string | null = null,
): Promise<void> {
  facts = await new PgPropertyStore(client).prepareFacts(tenantId, sessionId, facts);
  // Facts of other sessions that a stale fact superseded would dangle (I5b).
  // Release them now; they are re-evaluated below against the new facts.
  const orphanTc = tenantClausePg(tenantId, 2);
  const orphans = (await client.query<{ id: string; subject: string; predicate: string; property_slug: string | null; property_source: string | null }>(
    `UPDATE facts SET superseded_by = NULL
     WHERE superseded_by IN (SELECT id FROM facts WHERE source_session_id = $1) AND source_session_id != $1 AND ${orphanTc.sql}
     RETURNING id, subject, predicate, property_slug, property_source`,
    [sessionId, orphanTc.param],
  )).rows;
  const deleteTc = tenantClausePg(tenantId, 2);
  await client.query(`DELETE FROM facts WHERE source_session_id = $1 AND ${deleteTc.sql}`, [sessionId, deleteTc.param]);

  for (const f of facts) {
    await client.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence, retired_at, scope, tenant_id, source_start, source_end, source_body_version, source_quote_status, property_slug, property_source, property_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [f.id, f.kind, f.subject, f.predicate, f.value, f.sourceSessionId,
       f.sourceQuote === null ? null : persistedText(f.sourceQuote), f.createdAt, f.supersededBy, f.confidence, f.retiredAt, scope, tenantId, ...anchorValues(f.sourceAnchor), ...propertyValues(f.property)],
    );
  }

  // Per (slug, subject, predicate) the newest active fact stays by created_at; the
  // rest collapse under it, so re-ingesting an old session cannot displace a newer fact.
  const collapseKey = async (subject: string, predicate: string, slug: string | null, incomingId?: string): Promise<void> => {
    const tc = tenantClausePg(tenantId, 4);
    const active = (await client.query<{ id: string; created_at: string | Date }>(
      `SELECT id, created_at FROM facts
       WHERE subject = $1 AND predicate = $2 AND superseded_by IS NULL AND retired_at IS NULL AND property_slug IS NOT DISTINCT FROM $3 AND ${tc.sql}`,
      [subject, predicate, slug, tc.param],
    )).rows;
    if (active.length < 2) return;
    const winner = newestFact(active, incomingId);
    const losers = active.filter((r) => r.id !== winner.id).map((r) => r.id);
    await client.query("UPDATE facts SET superseded_by = $1 WHERE id = ANY($2)", [winner.id, losers]);
    await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [losers]);
  };
  for (const f of collapseWinners(facts)) await collapseKey(f.subject, f.predicate, f.property?.slug ?? null, f.id);
  for (const o of orphans) {
    if (collapses(o.predicate, o.property_slug, o.property_source)) await collapseKey(o.subject, o.predicate, o.property_slug);
  }
}
