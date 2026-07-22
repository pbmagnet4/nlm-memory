// tests/helpers/seed-tenant-corpus-pg.ts
/**
 * Pg twin of seed-tenant-corpus.ts (Wave C5). Seeds the same two tenants
 * (team_a, team_b) with the same disjoint content + adversarial overlaps
 * (near-identical fact embeddings, shared entity surface form, shared signal
 * repo basename) into a real Postgres instance via PgStorage, so
 * tenant-leak-contract.pg.test.ts exercises the pg-backed store classes
 * (Wave B, pg lane) rather than re-testing sqlite under a different name.
 *
 * Requires NLM_PG_TEST_URL. Truncates the STAMP + DERIVE tables before
 * seeding so repeated runs start clean; caller owns teardown via
 * `fixture.storage.close()`.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { PgSessionStore } from "../../src/core/storage/pg-session-store.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import type { PgFactStore } from "../../src/core/storage/pg-fact-store.js";
import type { PgCodeExemplarStore } from "../../src/core/storage/pg-code-exemplar-store.js";
import type { PgSignalStore } from "../../src/core/storage/pg-signal-store.js";
import type { PgWorkstreamStore } from "../../src/core/storage/pg-workstream-store.js";
import type { PgEntityStore } from "../../src/core/storage/pg-entity-store.js";
import type { Fact, Signal } from "../../src/shared/types.js";

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");
const DIMS = 768;

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, code_exemplar_embeddings, code_exemplars,
    signals, workstream_entities, workstreams,
    entity_variants, entities, sessions, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

export interface TenantSeedIds {
  readonly sessionIds: readonly [string, string];
  readonly factIds: readonly [string, string];
  readonly exemplarId: string;
  readonly signalId: string;
  readonly workstreamId: string;
  readonly entityCanonical: string;
  readonly soloEntityCanonical: string;
  readonly repo: string;
}

export interface SeededTenantCorpusPg {
  readonly storage: PgStorage;
  readonly sessionStore: PgSessionStore;
  readonly factStore: PgFactStore;
  readonly exemplarStore: PgCodeExemplarStore;
  readonly signalStore: PgSignalStore;
  readonly workstreamStore: PgWorkstreamStore;
  readonly entityStore: PgEntityStore;
  readonly ids: { readonly A: TenantSeedIds; readonly B: TenantSeedIds };
}

const ENTITY_CANONICAL = "shared-entity";
const REPO_BASENAME = "acme-widgets";

function baseVector(salt: number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Math.sin((i + 1) * salt);
  return v;
}

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

async function seedTeam(fixture: Omit<SeededTenantCorpusPg, "ids">, spec: TeamSpec): Promise<TenantSeedIds> {
  const { teamId, repoPath } = spec;
  const { sessionStore, factStore, exemplarStore, signalStore, workstreamStore, storage } = fixture;
  const sessionIds: [string, string] = [`session-${teamId}-1`, `session-${teamId}-2`];
  const factIds: [string, string] = [`fact-${teamId}-1`, `fact-${teamId}-2`];
  const signalId = `signal-${teamId}`;
  const workstreamId = `workstream-${teamId}`;
  const soloEntityCanonical = `solo-entity-${teamId}`;

  await storage.pgPool().query("INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [teamId, spec.teamName]);

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
  await sessionStore.insertSession(
    teamId,
    baseRecord(
      sessionIds[1], `rt-${teamId}-2`, `${teamId} follow-up session`, `${teamId} summary two`,
      `Body content unique to ${teamId}, session two.`, [ENTITY_CANONICAL, soloEntityCanonical],
    ),
  );

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
  const epsilon = teamId === "team_a" ? 0 : 1e-4;
  await factStore.upsertEmbedding(teamId, factIds[0], nearNeighbor(baseVector(1), epsilon));
  await factStore.upsertEmbedding(teamId, factIds[1], nearNeighbor(baseVector(2), epsilon));

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

  await workstreamStore.create(teamId, { id: workstreamId, label: `${teamId} workstream`, scope: null });
  await workstreamStore.upsertEntities(teamId, workstreamId, [ENTITY_CANONICAL]);
  await sessionStore.setWorkstreamBinding(teamId, sessionIds[0], workstreamId, "classifier", 1.0);

  return {
    sessionIds, factIds, exemplarId, signalId, workstreamId,
    entityCanonical: ENTITY_CANONICAL, soloEntityCanonical, repo: repoPath,
  };
}

export async function seedTenantCorpusPg(connectionString: string): Promise<SeededTenantCorpusPg> {
  const storage = PgStorage.create({ connectionString, migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  await storage.pgPool().query(TRUNCATE_SQL);

  const base: Omit<SeededTenantCorpusPg, "ids"> = {
    storage,
    sessionStore: storage.sessions,
    factStore: storage.facts,
    exemplarStore: storage.exemplars,
    signalStore: storage.signals,
    workstreamStore: storage.workstreams,
    entityStore: storage.entities,
  };

  const A = await seedTeam(base, { teamId: "team_a", teamName: "Team A", repoPath: `/workspaces/team-a/${REPO_BASENAME}` });
  const B = await seedTeam(base, { teamId: "team_b", teamName: "Team B", repoPath: `/srv/team-b/${REPO_BASENAME}` });

  return { ...base, ids: { A, B } };
}
