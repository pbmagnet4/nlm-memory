/**
 * PgStorage adapter: EntityStore contract + ingest-side variant lookup.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runEntityStoreContract,
  type EntityStoreContractHarness,
} from "../contract/entity-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    entity_variants,
    workstream_entities, workstreams,
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

async function makeStorage(): Promise<PgStorage> {
  if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
  const storage = PgStorage.create({
    connectionString: PG_TEST_URL,
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  await storage.pgPool().query(TRUNCATE_SQL);
  return storage;
}

const harness: EntityStoreContractHarness = {
  name: "PgStorage",

  async setup(): Promise<Storage> {
    return makeStorage();
  },

  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },

  async seedSession(storage: Storage, sessionId: string, startedAt: string): Promise<void> {
    await (storage as PgStorage).pgPool().query(
      `INSERT INTO sessions
         (id, runtime, runtime_session_id, started_at, label, summary, body, status, transcript_kind)
       VALUES ($1, 'test', $1, $2, 'lbl', 'sum', '', 'closed', 'claude-code-jsonl')
       ON CONFLICT DO NOTHING`,
      [sessionId, startedAt],
    );
  },

  async seedEntity(
    storage: Storage,
    canonical: string,
    opts: { sessionIds?: string[]; firstSeen?: string; lastSeen?: string; status?: string },
  ): Promise<void> {
    const pool = (storage as PgStorage).pgPool();
    const status = opts.status ?? "candidate";
    const firstSeen = opts.firstSeen ?? opts.sessionIds?.[0] ?? null;
    const lastSeen = opts.lastSeen ?? opts.sessionIds?.[opts.sessionIds.length - 1] ?? null;
    await pool.query(
      `INSERT INTO entities (canonical, type, status, first_seen_session, last_seen_session, session_count)
       VALUES ($1, 'candidate', $2, $3, $4, 0)
       ON CONFLICT (canonical) DO NOTHING`,
      [canonical, status, firstSeen, lastSeen],
    );
    for (const sid of opts.sessionIds ?? []) {
      await pool.query(
        "INSERT INTO session_entities (session_id, entity_canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [sid, canonical],
      );
    }
    const count = (opts.sessionIds ?? []).length;
    await pool.query("UPDATE entities SET session_count = $1 WHERE canonical = $2", [count, canonical]);
  },

  async seedVariant(storage: Storage, variant: string, canonical: string): Promise<void> {
    await (storage as PgStorage).pgPool().query(
      "INSERT INTO entity_variants (variant, canonical) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [variant, canonical],
    );
  },

  async getEntityRow(storage: Storage, canonical: string) {
    const res = await (storage as PgStorage).pgPool().query<{
      status: string;
      session_count: number;
      first_seen_session: string | null;
      last_seen_session: string | null;
    }>(
      "SELECT status, session_count, first_seen_session, last_seen_session FROM entities WHERE canonical = $1",
      [canonical],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      sessionCount: row.session_count,
      firstSeenSession: row.first_seen_session,
      lastSeenSession: row.last_seen_session,
    };
  },

  async getVariantRow(storage: Storage, variant: string) {
    const res = await (storage as PgStorage).pgPool().query<{ canonical: string }>(
      "SELECT canonical FROM entity_variants WHERE variant = $1",
      [variant],
    );
    return res.rows[0] ?? null;
  },

  async getSessionEntityLinks(storage: Storage, entityCanonical: string) {
    const res = await (storage as PgStorage).pgPool().query<{ session_id: string }>(
      "SELECT session_id FROM session_entities WHERE entity_canonical = $1",
      [entityCanonical],
    );
    return res.rows.map((r) => r.session_id);
  },
};

describe.skipIf(!PG_TEST_URL)(
  "PgStorage: entity-store contract",
  () => {
    runEntityStoreContract(harness);
  },
);

describe.skipIf(!PG_TEST_URL)("ingest-side variant lookup (PgStorage)", () => {
  let storage: PgStorage;

  beforeEach(async () => {
    storage = await makeStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("ingest of a merged surface form links to the canonical entity", async () => {
    const pool = storage.pgPool();

    await pool.query(
      `INSERT INTO sessions
         (id, runtime, runtime_session_id, started_at, label, summary, body, status, transcript_kind)
       VALUES ('sess_canonical', 'test', 'sess_canonical', '2026-01-01T00:00:00Z', 'lbl', 'sum', '', 'closed', 'claude-code-jsonl')`,
    );
    await pool.query(
      "INSERT INTO entities (canonical, type, status, session_count) VALUES ('canonical-ent', 'candidate', 'candidate', 0)",
    );
    await pool.query(
      "INSERT INTO entity_variants (variant, canonical) VALUES ('old-spelling', 'canonical-ent')",
    );

    await storage.sessions.insertSession("team_local", {
      id: "sess_new",
      runtime: "claude-code",
      runtimeSessionId: "sess_new",
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
      durationMin: null,
      label: "test",
      summary: "test",
      body: "test",
      status: "closed",
      transcriptKind: "claude-code-jsonl",
      transcriptPath: null,
      transcriptOffset: null,
      transcriptLength: null,
      entities: ["old-spelling"],
      decisions: [],
      openQuestions: [],
      scope: null,
    });

    const linksRes = await pool.query<{ session_id: string }>(
      "SELECT session_id FROM session_entities WHERE entity_canonical = $1",
      ["canonical-ent"],
    );
    const links = linksRes.rows.map((r) => r.session_id);
    expect(links).toContain("sess_new");

    const retiredRes = await pool.query<{ session_id: string }>(
      "SELECT session_id FROM session_entities WHERE entity_canonical = $1",
      ["old-spelling"],
    );
    expect(retiredRes.rows).toHaveLength(0);
  });
});
