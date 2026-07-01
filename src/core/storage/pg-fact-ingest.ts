/**
 * Single source of truth for pg fact-ingest. Caller owns the transaction:
 * this function MUST run on a client that already issued BEGIN.
 *
 * Mirrors SqliteFactStore.ingestSessionFactsInTxn semantics (NLM #351):
 *  - re-ingest clears prior facts for the session (fact_embeddings rows for
 *    DELETED facts self-clean via the FK ON DELETE CASCADE; UPDATE-superseded
 *    facts below need an explicit embedding delete)
 *  - one winner per (subject, predicate) per batch — last in batch wins —
 *    so an intra-batch duplicate can never create a mutual supersedence cycle
 *  - every fact the collapse supersedes leaves the ANN index immediately
 */

import type { PoolClient } from "pg";
import type { Fact } from "@shared/types.js";

export async function ingestSessionFactsOnClient(
  client: PoolClient,
  sessionId: string,
  facts: ReadonlyArray<Fact>,
): Promise<void> {
  await client.query("DELETE FROM facts WHERE source_session_id = $1", [sessionId]);
  if (facts.length === 0) return;

  for (const f of facts) {
    await client.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [f.id, f.kind, f.subject, f.predicate, f.value, f.sourceSessionId,
       f.sourceQuote, f.createdAt, f.supersededBy, f.confidence, f.retiredAt],
    );
  }

  const winners = new Map<string, Fact>();
  for (const f of facts) winners.set(`${f.subject}\u0000${f.predicate}`, f);
  for (const f of winners.values()) {
    const collapsed = await client.query<{ id: string }>(
      `UPDATE facts SET superseded_by = $1
       WHERE subject = $2 AND predicate = $3 AND superseded_by IS NULL AND id != $1
       RETURNING id`,
      [f.id, f.subject, f.predicate],
    );
    const ids = collapsed.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [ids]);
    }
  }
}
