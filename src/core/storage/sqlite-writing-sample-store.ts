/**
 * SqliteWritingSampleStore — WritingSampleStore over the shared better-sqlite3
 * connection (same handle as the rest of SqliteStorage).
 *
 * Insert is idempotent: the primary key is sha256 of the dedup tuple, so
 * re-importing the same published post is an `INSERT OR IGNORE` no-op reported
 * as `skipped`. `text_hash` covers the *normalised* text, so whitespace and
 * casing differences between two exports of one post still dedupe.
 *
 * `install_scope` is stamped here from `installScope()` — the port's input has
 * no field for it, so no caller (HTTP body, CLI flag, MCP argument) can pick
 * the scope it wants to read back. `installScopeProvider` exists so a test can
 * pin the value instead of borrowing this machine's ~/.nlm/install-id;
 * production never passes it.
 *
 * Tenancy mirrors SqliteCodeExemplarStore: `writing_samples` is a STAMP table,
 * every SELECT/DELETE routes its WHERE fragment through `tenantClause`, and
 * INSERTs stamp `tenant_id` explicitly. `writing_samples_vec` carries no
 * tenant_id (DERIVE-VIA-FK), so the tenant filter lives inside the
 * id-resolution SQL in the read module — see its header.
 *
 * Reads that touch vectors go through SqliteSemanticReader when one is wired
 * (T1770); the inline path below is only for stores built without a reader.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { installScope } from "@core/signals/install-scope.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import type {
  WritingSampleHit,
  WritingSampleInput,
  WritingSampleLatestHit,
  WritingSampleMissing,
  WritingSampleSearchFilter,
  WritingSampleStore,
} from "@ports/writing-sample-store.js";
import { readSemanticWritingSamples, type WritingSampleReadFilter } from "./sqlite-semantic-writing-samples.js";
import type { SqliteSemanticReader } from "./sqlite-semantic-reader.js";

/**
 * Deterministic primary key: sha256(tenant_id|install_scope|voice|channel|text_hash|source)[:16].
 * The tenant is part of it so dedup is per tenant: two tenants storing the same
 * post get two rows (review 0e604bf5).
 * `source` is in the tuple on purpose: the same post first ingested as
 * `approved` and later as `published` is two rows, and recall prefers the
 * higher source (design invariant 2).
 */
export function writingSampleId(parts: {
  tenantId: string;
  installScope: string;
  voice: string;
  channel: string;
  textHash: string;
  source: string;
}): string {
  return createHash("sha256")
    .update([parts.tenantId, parts.installScope, parts.voice, parts.channel, parts.textHash, parts.source].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/** Trim, collapse internal whitespace runs, lowercase: the dedup identity of a piece of writing. */
export function normaliseWritingText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** sha256 of {@link normaliseWritingText}, hex. */
export function writingTextHash(text: string): string {
  return createHash("sha256").update(normaliseWritingText(text)).digest("hex");
}

export interface SqliteWritingSampleStoreOptions {
  /** Overrides `installScope()`; tests only. */
  readonly installScopeProvider?: (() => string) | undefined;
}

type SampleRow = {
  id: string;
  install_scope: string;
  voice: string;
  channel: string;
  audience: string | null;
  source: WritingSampleInput["source"];
  source_ref: string | null;
  text: string;
  text_hash: string;
  context: string | null;
  outcome: WritingSampleInput["outcome"];
  draft_id: string | null;
  session_id: string | null;
  rules_version: string | null;
  ts: string;
  created_at: string;
};

/** better-sqlite3 has no binding for `undefined`, so every optional field lands as SQL NULL. */
function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

export class SqliteWritingSampleStore implements WritingSampleStore {
  private readonly resolveScope: () => string;

  constructor(
    private readonly db: Database.Database,
    private readonly semanticReader?: SqliteSemanticReader,
    opts: SqliteWritingSampleStoreOptions = {},
  ) {
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
    const info = this.insertStmt().run({
      id,
      install_scope: scope,
      voice: input.voice,
      channel: input.channel,
      audience: nullable(input.audience),
      source: input.source,
      source_ref: nullable(input.sourceRef),
      text: input.text,
      text_hash: textHash,
      context: nullable(input.context),
      outcome: input.outcome,
      draft_id: nullable(input.draftId),
      session_id: nullable(input.sessionId),
      rules_version: nullable(input.rulesVersion),
      ts: input.ts,
      created_at: new Date().toISOString(),
      tenant_id: tenantId,
    } satisfies SampleRow & { tenant_id: string });
    return { id, skipped: info.changes === 0 };
  }

  /**
   * No-op if the sample isn't owned by tenantId — writing an embedding for
   * another tenant's sample must never fall through to a write.
   */
  async upsertEmbedding(tenantId: string, id: string, vector: Float32Array): Promise<void> {
    const tc = tenantClause(tenantId);
    const owned = this.db
      .prepare<[string, string], { id: string }>(`SELECT id FROM writing_samples WHERE id = ? AND ${tc.sql}`)
      .get(id, tc.param);
    if (!owned) return;
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare("DELETE FROM writing_samples_vec WHERE sample_id = ?").run(id);
    this.db.prepare("INSERT INTO writing_samples_vec (sample_id, embedding) VALUES (?, ?)").run(id, buf);
  }

  async missingEmbeddings(tenantId: string, limit: number): Promise<ReadonlyArray<WritingSampleMissing>> {
    if (!(limit > 0)) return [];
    const tc = tenantClause(tenantId);
    return this.db
      .prepare<[string, number], WritingSampleMissing>(
        `SELECT id, text FROM writing_samples
         WHERE id NOT IN (SELECT sample_id FROM writing_samples_vec) AND ${tc.sql}
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .all(tc.param, Math.trunc(limit));
  }

  async search(
    tenantId: string,
    queryVector: Float32Array,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleHit>> {
    if (filter.outcomes.length === 0) return [];
    const readFilter: WritingSampleReadFilter = {
      installScope: this.resolveScope(),
      voice: filter.voice,
      ...(filter.channel !== undefined ? { channel: filter.channel } : {}),
      outcomes: filter.outcomes,
    };
    const k = Math.max(1, Math.min(50, Math.trunc(filter.k)));
    if (this.semanticReader) {
      return this.semanticReader.read({
        lane: "writing-samples",
        tenantId,
        queryVector,
        limit: k,
        options: readFilter,
      }) as Promise<ReadonlyArray<WritingSampleHit>>;
    }
    return readSemanticWritingSamples(this.db, tenantId, queryVector, k, readFilter);
  }

  async latest(
    tenantId: string,
    filter: WritingSampleSearchFilter,
  ): Promise<ReadonlyArray<WritingSampleLatestHit>> {
    if (filter.outcomes.length === 0) return [];
    const tc = tenantClause(tenantId);
    const where = [`${tc.sql}`, "install_scope = ?", "voice = ?"];
    const params: unknown[] = [tc.param, this.resolveScope(), filter.voice];
    if (filter.channel !== undefined) {
      where.push("channel = ?");
      params.push(filter.channel);
    }
    where.push(`outcome IN (${filter.outcomes.map(() => "?").join(",")})`);
    params.push(...filter.outcomes);
    const k = Math.max(1, Math.min(50, Math.trunc(filter.k)));
    return this.db
      .prepare<unknown[], SampleRow>(
        `SELECT id, install_scope, voice, channel, audience, source, source_ref,
                text, text_hash, context, outcome, draft_id, session_id, rules_version,
                ts, created_at
         FROM writing_samples
         WHERE ${where.join(" AND ")}
         ORDER BY ts DESC, id ASC
         LIMIT ?`,
      )
      .all(...params, k)
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

  private insertStmt() {
    return this.db.prepare<SampleRow & { tenant_id: string }>(`
      INSERT OR IGNORE INTO writing_samples (
        id, install_scope, voice, channel, audience, source, source_ref,
        text, text_hash, context, outcome, draft_id, session_id, rules_version,
        ts, created_at, tenant_id
      ) VALUES (
        @id, @install_scope, @voice, @channel, @audience, @source, @source_ref,
        @text, @text_hash, @context, @outcome, @draft_id, @session_id, @rules_version,
        @ts, @created_at, @tenant_id
      )
    `);
  }
}
