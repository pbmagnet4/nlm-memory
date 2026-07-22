/**
 * EntityStore -- read/write surface for the entities + entity_variants tables.
 *
 * Lives on Storage.entities. Both SQLite and PG adapters implement this port.
 */

export interface EntityRow {
  readonly canonical: string;
  readonly type: string;
  readonly status: string;
  readonly sessionCount: number;
  readonly firstSeenSession: string | null;
  readonly lastSeenSession: string | null;
}

export interface EntityStore {
  /**
   * Merge source entity into target entity.
   *
   * Semantics (both adapters, inside one transaction):
   *   1. INSERT OR IGNORE (pg: ON CONFLICT DO NOTHING) session_entities rows
   *      from source onto target to preserve all session links.
   *   2. DELETE the source's session_entities rows.
   *   3. Recompute target.session_count exactly from session_entities.
   *   4. Widen target first_seen_session / last_seen_session to the
   *      chronologically earliest / latest session across both entities.
   *   5. INSERT INTO entity_variants (variant=source, canonical=target,
   *      source_session_id=NULL) so future ingest of the old surface form
   *      binds to the canonical.
   *   6. Re-point any existing entity_variants rows where canonical=source
   *      to canonical=target.
   *   7. Keep the source entities row with status='retired', session_count=0.
   *
   * Errors loudly when target is missing or already retired.
   *
   * Tenancy (program spec §4, M2 plan Wave B4): entities is a STAMP table
   * with composite PK (tenant_id, canonical). Merge operates within one
   * tenant only — source and target must both resolve within tenantId.
   */
  merge(tenantId: string, source: string, target: string): Promise<void>;
}
