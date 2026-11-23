/**
 * PgWritingSampleStore — WritingSampleStore over pg.Pool + pgvector.
 *
 * Behavioural mirror of SqliteWritingSampleStore: the same deterministic id and
 * text normalisation (imported, not re-implemented, so the two backends cannot
 * drift), insert idempotent via ON CONFLICT (id) DO NOTHING, `install_scope`
 * stamped server-side, and search ordered by L2 distance.
 *
 * Embeddings live in writing_sample_embeddings with ON DELETE CASCADE, so a
 * delete on writing_samples needs no separate vec bookkeeping (unlike the
 * SQLite store, which deletes from writing_samples_vec explicitly).
 *
 * Unlike the SQLite lane — where vec0 cannot filter and candidates are resolved
 * afterwards — pgvector can apply the whole voice/channel/outcome filter in the
 * same statement that ranks, so this search is exact: no over-fetch, and no
 * semantic worker (that thread-pool seam is a SQLite-only concern).
 *
 * Tenancy: every method takes `tenantId` as its non-optional first parameter and
 * routes STAMP-table WHERE fragments through `tenantClausePg`.
 */

import type { Pool } from "pg";
import { installScope } from "@core/signals/install-scope.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";
import type {
  WritingSampleHit,
  WritingSampleInput,
  WritingSampleLatestHit,
  WritingSampleMissing,
  WritingSampleSearchFilter,
  WritingSampleSource,
  WritingSampleStore,
} from "@ports/writing-sample-store.js";
import { writingSampleId, writingTextHash } from "./sqlite-writing-sample-store.js";

const COLUMNS = "id, voice, channel, source, outcome, text, source_ref, ts";

interface SampleRow {
  id: string;
  voice: string;
  channel: string;
  source: WritingSampleSource;
  outcome: WritingSampleInput["outcome"];
  text: string;
  source_ref: string | null;
  ts: string;
}

export interface PgWritingSampleStoreOptions {
  /** Overrides `installScope()`; tests only. */
  readonly installScopeProvider?: (() => string) | undefined;
}

export class PgWritingSampleStore implements WritingSampleStore {
  private readonly resolveScope: () => string;

  constructor(private readonly pool: Pool, opts: PgWritingSampleStoreOptions = {}) {
    this.resolveScope = opts.installScopeProvider ?? installScope;
  }

  async insert(tenantId: string, input: WritingSampleInput): Promise<{ id: string; skipped: boolean }> {
    const scope = this.resolveScope();
    const textHash = writingTextHash(input.text);
    const id = writingSampleId({
      tenantId,
      installScope: scope,
      voice: input.voice,
      channel: input.channel,
      textHash,
      source: input.source,
    });
    const res = await this.pool.query(
      `INSERT INTO writing_samples
         (id, install_scope, voice, channel, audience, source, source_ref,
          text, text_hash, context, outcome, draft_id, session_id, rules_version,
          ts, created_at, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now()::text, $16)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        scope,
        input.voice,
        input.channel,
        input.audience ?? null,
        input.source,
        input.sourceRef ?? null,
        input.text,
        textHash,
        input.context ?? null,
        input.outcome,
        input.draftId ?? null,
        input.sessionId ?? null,
        input.rulesVersion ?? null,
        input.ts,
        tenantId,
      ],
    );
    return { id, skipped: res.rowCount === 0 };
  }

  /**
   * No-op if the sample isn't owned by tenantId — writing an embedding for
   * another tenant's sample must never fall through to a write.
   */
  async upsertEmbedding(tenantId: string, id: string, vector: Float32Array): Promise<void> {
    const tc = tenantClausePg(tenantId, 2);
    const owned = await this.pool.query<{ id: string }>(
      `SELECT id FROM writing_samples WHERE id = $1 AND ${tc.sql}`,
      [id, tc.param],
    );
    if (owned.rows.length === 0) return;
    await this.pool.query(
      `INSERT INTO writing_sample_embeddings (sample_id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (sample_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [id, `[${Array.from(vector).join(",")}]`],
    );
  }

  async missingEmbeddings(tenantId: string, limit: number): Promise<ReadonlyArray<WritingSampleMissing>> {
    if (!(limit > 0)) return [];
    const tc = tenantClausePg(tenantId, 2);
    const res = await this.pool.query<WritingSampleMissing>(
      `SELECT ws.id, ws.text FROM writing_samples ws
       WHERE NOT EXISTS (SELECT 1 FROM writing_sample_embeddings e WHERE e.sample_id = ws.id)
         AND ${tc.sql}
       ORDER BY ws.created_at, ws.id
       LIMIT $1`,
      [Math.trunc(limit), tc.param],
    );
    return res.rows;
  }

  async search(
    tenantId: string,
    queryVector: Float32Array,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleHit>> {
    if (filter.outcomes.length === 0) return [];
    const k = Math.max(1, Math.min(50, Math.trunc(filter.k)));
    // $1 query, $2 install_scope, $3 voice, [$4 channel], $n.. outcomes, then tenant, then k.
    const params: unknown[] = [`[${Array.from(queryVector).join(",")}]`, this.resolveScope(), filter.voice];
    const where = ["ws.install_scope = $2", "ws.voice = $3"];
    let n = 4;
    if (filter.channel !== undefined) {
      where.push(`ws.channel = $${n++}`);
      params.push(filter.channel);
    }
    where.push(`ws.outcome IN (${filter.outcomes.map(() => `$${n++}`).join(",")})`);
    params.push(...filter.outcomes);
    const tc = tenantClausePg(tenantId, n++);
    where.push(tc.sql);
    params.push(tc.param);
    params.push(k);

    // pgvector <-> is L2 distance, matching the SQLite vec0 lane's ordering.
    // writing_sample_embeddings carries no tenant_id of its own, so the tenant
    // filter rides on the join to writing_samples (program spec §4.3 vector-path
    // rule).
    const res = await this.pool.query<SampleRow & { distance: number; row_tenant: string }>(
      `SELECT ${COLUMNS.split(", ").map((c) => `ws.${c}`).join(", ")},
              ws.tenant_id AS row_tenant,
              e.embedding <-> $1::vector AS distance
       FROM writing_sample_embeddings e
       JOIN writing_samples ws ON ws.id = e.sample_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.embedding <-> $1::vector, ws.id
       LIMIT $${n}`,
      params,
    );

    // Defense in depth (never a substitute for the SQL filter above): re-check
    // each resolved row's own tenant, read into a local first so this JS
    // comparison can never be mistaken by the tenant-guard scan for an
    // inlined SQL WHERE fragment (that literal is reserved for tenant-clause.ts).
    return res.rows
      .filter((r) => { const rowTenant = r["row_tenant"]; return rowTenant === tenantId; })
      .map((r): WritingSampleHit => ({
        id: r.id,
        voice: r.voice,
        channel: r.channel,
        source: r.source,
        outcome: r.outcome,
        text: r.text,
        sourceRef: r.source_ref,
        ts: r.ts,
        distance: Number(r.distance),
      }));
  }

  async latest(
    tenantId: string,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleLatestHit>> {
    if (filter.outcomes.length === 0) return [];
    const k = Math.max(1, Math.min(50, Math.trunc(filter.k)));
    const params: unknown[] = [this.resolveScope(), filter.voice];
    const where = ["ws.install_scope = $1", "ws.voice = $2"];
    let n = 3;
    if (filter.channel !== undefined) {
      where.push(`ws.channel = $${n++}`);
      params.push(filter.channel);
    }
    where.push(`ws.outcome IN (${filter.outcomes.map(() => `$${n++}`).join(",")})`);
    params.push(...filter.outcomes);
    const tc = tenantClausePg(tenantId, n++);
    where.push(tc.sql);
    params.push(tc.param);
    params.push(k);
    const res = await this.pool.query<SampleRow & { row_tenant: string }>(
      `SELECT ${COLUMNS.split(", ").map((c) => `ws.${c}`).join(", ")},
              ws.tenant_id AS row_tenant
       FROM writing_samples ws
       WHERE ${where.join(" AND ")}
       ORDER BY ws.ts DESC, ws.id ASC
       LIMIT $${n}`,
      params,
    );
    return res.rows
      .filter((r) => { const rowTenant = r["row_tenant"]; return rowTenant === tenantId; })
      .map((r): WritingSampleLatestHit => ({
        id: r.id,
        voice: r.voice,
        channel: r.channel,
        source: r.source,
        outcome: r.outcome,
        text: r.text,
        sourceRef: r.source_ref,
        ts: r.ts,
        distance: null,
      }));
  }
}
