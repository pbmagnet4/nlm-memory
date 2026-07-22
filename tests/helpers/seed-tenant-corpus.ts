// tests/helpers/seed-tenant-corpus.ts
/**
 * Fixture for the tenant-leak-contract suite (program spec §6). Seeds two
 * tenants (team_a, team_b) into a fresh temp sqlite db, each with disjoint
 * content PLUS the adversarial overlaps the contract names: fact embeddings
 * that are near-identical across tenants (the vector-neighbor trap), the
 * same entity surface form registered in both corpora, and signals sharing a
 * repo basename.
 *
 * Bootstrap mirrors tests/integration/tenant-schema.test.ts (WAL pragma +
 * sqlite-vec load + runMigrations) so the fixture exercises the exact same
 * schema production writes against.
 *
 * Every corpus write here is raw SQL rather than going through the store
 * classes. This is deliberate, not a shortcut: none of the 19 store classes
 * accept a tenantId yet (that's Wave B's job — see the plan). Calling e.g.
 * SqliteFactStore.insert() today would silently stamp every row with
 * whatever the column DEFAULT is ('team_local'), which defeats the point of
 * a two-tenant fixture. Once Wave B threads tenantId through the store
 * signatures, this fixture is expected to be rewritten against the real
 * stores (compiler-driven, like every other caller).
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/core/storage/migrate.js";

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

function seedTeam(db: Database.Database, spec: TeamSpec): TenantSeedIds {
  const { teamId, repoPath } = spec;
  const sessionIds: [string, string] = [`session-${teamId}-1`, `session-${teamId}-2`];
  const factIds: [string, string] = [`fact-${teamId}-1`, `fact-${teamId}-2`];
  const exemplarId = `exemplar-${teamId}`;
  const signalId = `signal-${teamId}`;
  const workstreamId = `workstream-${teamId}`;

  db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(teamId, spec.teamName);

  // ── Sessions (disjoint labels/bodies) ────────────────────────────────────
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, body, status, tenant_id)
    VALUES (?, 'claude-code', ?, '2026-07-20T00:00:00Z', ?, ?, ?, 'closed', ?)
  `);
  insertSession.run(
    sessionIds[0], `rt-${teamId}-1`,
    `${teamId} onboarding session`, `${teamId} summary one`, `Body content unique to ${teamId}, session one.`,
    teamId,
  );
  insertSession.run(
    sessionIds[1], `rt-${teamId}-2`,
    `${teamId} follow-up session`, `${teamId} summary two`, `Body content unique to ${teamId}, session two.`,
    teamId,
  );

  // ── Entity: same surface form in both tenants, composite-keyed rows ─────
  db.prepare(
    "INSERT INTO entities (tenant_id, canonical, type, status, source) VALUES (?, ?, 'concept', 'active', 'fixture')",
  ).run(teamId, ENTITY_CANONICAL);
  db.prepare(
    "INSERT INTO session_entities (tenant_id, session_id, entity_canonical) VALUES (?, ?, ?)",
  ).run(teamId, sessionIds[0], ENTITY_CANONICAL);

  // ── Facts: 2 per tenant, embeddings near-identical across tenants ───────
  const insertFact = db.prepare(`
    INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, source_quote, confidence, tenant_id)
    VALUES (?, 'attribute', ?, ?, ?, ?, NULL, 0.9, ?)
  `);
  const insertFactEmbedding = db.prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)");
  insertFact.run(factIds[0], `${teamId}-subject-one`, "uses", `${teamId} value one`, sessionIds[0], teamId);
  insertFact.run(factIds[1], `${teamId}-subject-two`, "uses", `${teamId} value two`, sessionIds[1], teamId);
  // salt 1 / 2 are shared across seedTeam calls so team_a and team_b land
  // near the same point in vector space for each fact index — a naive
  // (untenanted) KNN scan would return the other team's row as top neighbor.
  const epsilon = teamId === "team_a" ? 0 : 1e-4;
  insertFactEmbedding.run(factIds[0], toBlob(nearNeighbor(baseVector(1), epsilon)));
  insertFactEmbedding.run(factIds[1], toBlob(nearNeighbor(baseVector(2), epsilon)));

  // ── Code exemplar (not adversarial — own embedding per tenant) ──────────
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
  db.prepare(`
    INSERT INTO signals (id, v, install_scope, kind, producer, outcome, model, repo, session_id, ts, tenant_id)
    VALUES (?, 1, ?, 'gate', 'quality-gate', 'pass', 'qwen3-coder', ?, ?, '2026-07-20T00:00:00Z', ?)
  `).run(signalId, teamId, repoPath, sessionIds[0], teamId);

  // ── Workstream + bindings ───────────────────────────────────────────────
  db.prepare(
    "INSERT INTO workstreams (id, label, status, tenant_id) VALUES (?, ?, 'active', ?)",
  ).run(workstreamId, `${teamId} workstream`, teamId);
  db.prepare(
    "INSERT INTO workstream_entities (tenant_id, workstream_id, entity_canonical, session_count) VALUES (?, ?, ?, 1)",
  ).run(teamId, workstreamId, ENTITY_CANONICAL);
  db.prepare(
    "UPDATE sessions SET workstream_id = ?, binding_source = 'auto', binding_confidence = 1.0 WHERE id = ?",
  ).run(workstreamId, sessionIds[0]);

  return { sessionIds, factIds, exemplarId, signalId, workstreamId, entityCanonical: ENTITY_CANONICAL, repo: repoPath };
}

/**
 * Seeds team_a/team_b into a fresh temp sqlite db. Caller owns cleanup:
 * `db.close()` then `rmSync(dir, { recursive: true, force: true })`.
 */
export function seedTenantCorpus(): SeededTenantCorpus {
  const dir = mkdtempSync(join(tmpdir(), "nlm-tenant-corpus-"));
  const db = new Database(join(dir, "t.sqlite"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  runMigrations(db, MIGRATIONS);

  const A = seedTeam(db, { teamId: "team_a", teamName: "Team A", repoPath: `/workspaces/team-a/${REPO_BASENAME}` });
  const B = seedTeam(db, { teamId: "team_b", teamName: "Team B", repoPath: `/srv/team-b/${REPO_BASENAME}` });

  return { db, dir, ids: { A, B } };
}
