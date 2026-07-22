// tests/helpers/seed-tenant-corpus.ts
/**
 * Fixture for the tenant-leak-contract suite (program spec §6). Seeds two
 * tenants (team_a, team_b) into a fresh temp sqlite db, each with disjoint
 * content PLUS the adversarial overlaps the contract names: fact embeddings
 * that are near-identical across tenants (the vector-neighbor trap), the
 * same entity surface form registered in both corpora, and signals sharing a
 * repo basename.
 *
 * Sessions and facts are seeded through the real SqliteSessionStore /
 * SqliteFactStore (both tenant-threaded as of M2 Wave B) so the fixture
 * exercises the exact write paths production uses — insertSession stamps
 * `tenant_id` on the session row AND resolves/links entities under that
 * tenant, so no separate raw entity-table SQL is needed for what
 * insertSession already covers.
 *
 * code_exemplars, signals, and workstreams are NOT yet tenant-threaded
 * (M2 Waves B3-B6) — those tables are still seeded with raw SQL directly
 * against the store's own connection, stamping tenant_id by hand.
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSessionStore, type IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { Fact } from "../../src/shared/types.js";

const MIGRATIONS = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations");
const DIMS = 768;

/** Ids seeded for one tenant, returned so contract cases can assert cross-tenant invisibility by id. */
export interface TenantSeedIds {
  readonly sessionIds: readonly [string, string];
  readonly factIds: readonly [string, string];
  readonly exemplarId: string;
  readonly signalId: string;
  readonly workstreamId: string;
  /** Shared surface form across both tenants — resolves to a tenant-local entities row on each side. */
  readonly entityCanonical: string;
  readonly repo: string;
}

export interface SeededTenantCorpus {
  readonly db: Database.Database;
  readonly dir: string;
  readonly sessionStore: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly ids: { readonly A: TenantSeedIds; readonly B: TenantSeedIds };
}

const ENTITY_CANONICAL = "shared-entity";
/** Same basename, different full path — the case-6 repo-basename trap. */
const REPO_BASENAME = "acme-widgets";

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Deterministic base vector for a given salt. */
function baseVector(salt: number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin((i + 1) * salt);
  return v;
}

/** Near-identical to `base` (tiny per-dimension epsilon) — the vector-neighbor trap. */
function nearNeighbor(base: Float32Array, epsilon: number): Float32Array {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i]! + epsilon;
  return v;
}

interface TeamSpec {
  readonly teamId: "team_a" | "team_b";
  readonly teamName: string;
  readonly repoPath: string;
}

async function seedTeam(
  sessionStore: SqliteSessionStore,
  factStore: SqliteFactStore,
  db: Database.Database,
  spec: TeamSpec,
): Promise<TenantSeedIds> {
  const { teamId, repoPath } = spec;
  const sessionIds: [string, string] = [`session-${teamId}-1`, `session-${teamId}-2`];
  const factIds: [string, string] = [`fact-${teamId}-1`, `fact-${teamId}-2`];
  const exemplarId = `exemplar-${teamId}`;
  const signalId = `signal-${teamId}`;
  const workstreamId = `workstream-${teamId}`;

  db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(teamId, spec.teamName);

  // ── Sessions (disjoint labels/bodies), via the real tenant-threaded store ─
  const baseRecord = (id: string, runtimeSessionId: string, label: string, summary: string, body: string): IngestRecord => ({
    id,
    runtime: "claude-code",
    runtimeSessionId,
    startedAt: "2026-07-20T00:00:00Z",
    endedAt: null,
    durationMin: null,
    label,
    summary,
    body,
    status: "closed",
    transcriptKind: null,
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [ENTITY_CANONICAL],
    decisions: [],
    openQuestions: [],
    scope: null,
  });
  await sessionStore.insertSession(
    teamId,
    baseRecord(sessionIds[0], `rt-${teamId}-1`, `${teamId} onboarding session`, `${teamId} summary one`, `Body content unique to ${teamId}, session one.`),
  );
  await sessionStore.insertSession(
    teamId,
    baseRecord(sessionIds[1], `rt-${teamId}-2`, `${teamId} follow-up session`, `${teamId} summary two`, `Body content unique to ${teamId}, session two.`),
  );

  // ── Facts: 2 per tenant, embeddings near-identical across tenants ───────
  const makeFact = (id: string, subject: string, value: string): Fact => ({
    id,
    kind: "attribute",
    subject,
    predicate: "uses",
    value,
    sourceSessionId: sessionIds[0],
    sourceQuote: null,
    createdAt: "2026-07-20T00:00:00Z",
    supersededBy: null,
    confidence: 0.9,
  });
  await factStore.insert(teamId, makeFact(factIds[0], `${teamId}-subject-one`, `${teamId} value one`));
  await factStore.insert(teamId, makeFact(factIds[1], `${teamId}-subject-two`, `${teamId} value two`));
  // salt 1 / 2 are shared across seedTeam calls so team_a and team_b land
  // near the same point in vector space for each fact index — a naive
  // (untenanted) KNN scan would return the other team's row as top neighbor.
  const epsilon = teamId === "team_a" ? 0 : 1e-4;
  await factStore.upsertEmbedding(teamId, factIds[0], nearNeighbor(baseVector(1), epsilon));
  await factStore.upsertEmbedding(teamId, factIds[1], nearNeighbor(baseVector(2), epsilon));

  // ── Code exemplar (not adversarial — own embedding per tenant) ──────────
  // code_exemplars is not yet tenant-threaded (M2 Wave B3) — raw SQL, hand-stamped.
  db.prepare(`
    INSERT INTO code_exemplars (
      id, install_scope, signal_id, session_id, repo, model, lang,
      task_context, code, code_hash, outcome, ts, tenant_id
    ) VALUES (?, ?, ?, ?, ?, 'qwen3-coder', 'ts', ?, ?, ?, 'pass', '2026-07-20T00:00:00Z', ?)
  `).run(
    exemplarId, teamId, signalId, sessionIds[0], repoPath,
    `${teamId} task context`, `// ${teamId} exemplar code`, `hash-${teamId}`, teamId,
  );
  db.prepare("INSERT INTO code_exemplars_vec (exemplar_id, embedding) VALUES (?, ?)").run(
    exemplarId, toBlob(baseVector(teamId === "team_a" ? 10 : 20)),
  );

  // ── Signal: same repo basename across tenants, different full path ─────
  // signals is not yet tenant-threaded (M2 Wave B4) — raw SQL, hand-stamped.
  db.prepare(`
    INSERT INTO signals (id, v, install_scope, kind, producer, outcome, model, repo, session_id, ts, tenant_id)
    VALUES (?, 1, ?, 'gate', 'quality-gate', 'pass', 'qwen3-coder', ?, ?, '2026-07-20T00:00:00Z', ?)
  `).run(signalId, teamId, repoPath, sessionIds[0], teamId);

  // ── Workstream + bindings ───────────────────────────────────────────────
  // workstreams/workstream_entities are not yet tenant-threaded (M2 Wave B4)
  // — raw SQL, hand-stamped. Session→workstream binding goes through the
  // real (threaded) SessionStore.setWorkstreamBinding.
  db.prepare(
    "INSERT INTO workstreams (id, label, status, tenant_id) VALUES (?, ?, 'active', ?)",
  ).run(workstreamId, `${teamId} workstream`, teamId);
  db.prepare(
    "INSERT INTO workstream_entities (tenant_id, workstream_id, entity_canonical, session_count) VALUES (?, ?, ?, 1)",
  ).run(teamId, workstreamId, ENTITY_CANONICAL);
  await sessionStore.setWorkstreamBinding(teamId, sessionIds[0], workstreamId, "classifier", 1.0);

  return { sessionIds, factIds, exemplarId, signalId, workstreamId, entityCanonical: ENTITY_CANONICAL, repo: repoPath };
}

/**
 * Seeds team_a/team_b into a fresh temp sqlite db. Caller owns cleanup:
 * `fixture.sessionStore.close()` then `rmSync(dir, { recursive: true, force: true })`.
 */
export async function seedTenantCorpus(): Promise<SeededTenantCorpus> {
  const dir = mkdtempSync(join(tmpdir(), "nlm-tenant-corpus-"));
  const dbPath = join(dir, "t.sqlite");
  const sessionStore = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS });
  const db = sessionStore.rawDb();
  const factStore = new SqliteFactStore(db);

  const A = await seedTeam(sessionStore, factStore, db, { teamId: "team_a", teamName: "Team A", repoPath: `/workspaces/team-a/${REPO_BASENAME}` });
  const B = await seedTeam(sessionStore, factStore, db, { teamId: "team_b", teamName: "Team B", repoPath: `/srv/team-b/${REPO_BASENAME}` });

  return { db, dir, sessionStore, factStore, ids: { A, B } };
}
