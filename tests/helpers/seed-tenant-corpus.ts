// tests/helpers/seed-tenant-corpus.ts
/**
 * Fixture for the tenant-leak-contract suite (program spec §6). Seeds two
 * tenants (team_a, team_b) into a fresh temp sqlite db, each with disjoint
 * content PLUS the adversarial overlaps the contract names: fact embeddings
 * that are near-identical across tenants (the vector-neighbor trap), the
 * same entity surface form registered in both corpora, and signals sharing a
 * repo basename.
 *
 * Every table this fixture seeds now goes through the real, tenant-threaded
 * store classes (M2 Waves B1-B4) — sessions/facts via SqliteSessionStore /
 * SqliteFactStore, code exemplars via SqliteCodeExemplarStore, signals via
 * SqliteSignalStore, workstreams via SqliteWorkstreamStore. No raw-SQL
 * corpus seeding remains; the fixture exercises the exact write paths
 * production uses, including tenant_id stamping.
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSessionStore, type IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { SqliteCodeExemplarStore } from "../../src/core/storage/sqlite-code-exemplar-store.js";
import { SqliteSignalStore } from "../../src/core/storage/sqlite-signal-store.js";
import { SqliteWorkstreamStore } from "../../src/core/storage/sqlite-workstream-store.js";
import { SqliteEntityStore } from "../../src/core/storage/sqlite-entity-store.js";
import type { Fact, Signal } from "../../src/shared/types.js";

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
  /** Tenant-unique entity, used as the merge source for case 3. */
  readonly soloEntityCanonical: string;
  readonly repo: string;
}

export interface SeededTenantCorpus {
  readonly db: Database.Database;
  readonly dir: string;
  readonly sessionStore: SqliteSessionStore;
  readonly factStore: SqliteFactStore;
  readonly exemplarStore: SqliteCodeExemplarStore;
  readonly signalStore: SqliteSignalStore;
  readonly workstreamStore: SqliteWorkstreamStore;
  readonly entityStore: SqliteEntityStore;
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
  exemplarStore: SqliteCodeExemplarStore,
  signalStore: SqliteSignalStore,
  workstreamStore: SqliteWorkstreamStore,
  db: Database.Database,
  spec: TeamSpec,
): Promise<TenantSeedIds> {
  const { teamId, repoPath } = spec;
  const sessionIds: [string, string] = [`session-${teamId}-1`, `session-${teamId}-2`];
  const factIds: [string, string] = [`fact-${teamId}-1`, `fact-${teamId}-2`];
  const signalId = `signal-${teamId}`;
  const workstreamId = `workstream-${teamId}`;
  const soloEntityCanonical = `solo-entity-${teamId}`;

  db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(teamId, spec.teamName);

  // ── Sessions (disjoint labels/bodies), via the real tenant-threaded store ─
  const baseRecord = (
    id: string,
    runtimeSessionId: string,
    label: string,
    summary: string,
    body: string,
    entities: ReadonlyArray<string>,
  ): IngestRecord => ({
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
    entities,
    decisions: [],
    openQuestions: [],
    scope: null,
  });
  await sessionStore.insertSession(
    teamId,
    baseRecord(
      sessionIds[0], `rt-${teamId}-1`, `${teamId} onboarding session`, `${teamId} summary one`,
      `Body content unique to ${teamId}, session one.`, [ENTITY_CANONICAL],
    ),
  );
  // Session two also carries a tenant-unique entity (case 3's merge source).
  await sessionStore.insertSession(
    teamId,
    baseRecord(
      sessionIds[1], `rt-${teamId}-2`, `${teamId} follow-up session`, `${teamId} summary two`,
      `Body content unique to ${teamId}, session two.`, [ENTITY_CANONICAL, soloEntityCanonical],
    ),
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
  const { id: exemplarId } = await exemplarStore.insert(teamId, {
    installScope: teamId,
    signalId,
    sessionId: sessionIds[0],
    repo: repoPath,
    model: "qwen3-coder",
    lang: "ts",
    taskContext: `${teamId} task context`,
    code: `// ${teamId} exemplar code`,
    codeHash: `hash-${teamId}`,
    outcome: "pass",
    gitSha: null,
    survived: null,
    scope: null,
    ts: "2026-07-20T00:00:00Z",
  });
  await exemplarStore.upsertEmbedding(teamId, exemplarId, baseVector(teamId === "team_a" ? 10 : 20));

  // ── Signal: same repo basename across tenants, different full path ─────
  const signal: Signal = {
    id: signalId,
    v: 1,
    installScope: teamId,
    kind: "gate",
    producer: "quality-gate",
    outcome: "pass",
    model: "qwen3-coder",
    repo: repoPath,
    step: null,
    detail: null,
    sessionId: sessionIds[0],
    scope: null,
    ts: "2026-07-20T00:00:00Z",
    createdAt: "2026-07-20T00:00:00Z",
  };
  await signalStore.insert(teamId, signal);

  // ── Workstream + bindings ───────────────────────────────────────────────
  await workstreamStore.create(teamId, { id: workstreamId, label: `${teamId} workstream`, scope: null });
  await workstreamStore.upsertEntities(teamId, workstreamId, [ENTITY_CANONICAL]);
  await sessionStore.setWorkstreamBinding(teamId, sessionIds[0], workstreamId, "classifier", 1.0);

  return {
    sessionIds, factIds, exemplarId, signalId, workstreamId,
    entityCanonical: ENTITY_CANONICAL, soloEntityCanonical, repo: repoPath,
  };
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
  const exemplarStore = new SqliteCodeExemplarStore(db);
  const signalStore = new SqliteSignalStore(db);
  const workstreamStore = new SqliteWorkstreamStore(db);
  const entityStore = new SqliteEntityStore(db);

  const A = await seedTeam(sessionStore, factStore, exemplarStore, signalStore, workstreamStore, db, {
    teamId: "team_a", teamName: "Team A", repoPath: `/workspaces/team-a/${REPO_BASENAME}`,
  });
  const B = await seedTeam(sessionStore, factStore, exemplarStore, signalStore, workstreamStore, db, {
    teamId: "team_b", teamName: "Team B", repoPath: `/srv/team-b/${REPO_BASENAME}`,
  });

  return { db, dir, sessionStore, factStore, exemplarStore, signalStore, workstreamStore, entityStore, ids: { A, B } };
}
