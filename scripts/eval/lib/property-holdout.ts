import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertionKey, attributeFacts, parseProperties, sessionPropertyReferences, type MemoryProperty } from "../../../src/core/properties/model.js";
import { anchorFromRow, type SourceAnchorRow } from "../../../src/core/storage/fact-source-anchor.js";
import { tenantClause } from "../../../src/core/tenancy/tenant-clause.js";
import type { Fact } from "../../../src/shared/types.js";
import { clean } from "./property-evidence.js";
import { factCard, sessionCard, type Card } from "./property-holdout-cards.js";
import {
  assertSnapshot, fileHash, LANES, pathsIn, privateDirectory, readJson, sha256, writePrivate, SEED, WINDOW_RULE, type Manifest,
} from "./property-holdout-io.js";
import { sessionMatches, type SessionStratum } from "./property-holdout-strata.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..");
export const L2_PROMPT_PATH = join(here, "..", "property-holdout-l2-prompt.md");
const STRATA_PATH = join(here, "property-holdout-strata.ts");
const CARDS_PATH = join(here, "property-holdout-cards.ts");
const MINORITY_RUNTIMES = new Set(["codex", "pi", "opencode"]);
const SESSION_TARGETS: Record<SessionStratum, number> = { C: 30, D: 100, E: 30 };
const SESSION_MINORITY_QUOTA = 30;
const ABSTENTION_CARDS = 20;

export const orderKey = (purpose: string, id: string): string => sha256(`${SEED}:${purpose}${id}`);
export function ordered<T>(items: readonly T[], id: (t: T) => string, purpose = ""): T[] {
  return [...items].sort((a, b) => orderKey(purpose, id(a)).localeCompare(orderKey(purpose, id(b))));
}
const runtimeFamily = (runtime: string): string => runtime.split("/")[0]!;

export function loadCatalog(path: string): MemoryProperty[] {
  return parseProperties(readJson<unknown>(path));
}
export const catalogHash = (catalog: readonly MemoryProperty[]): string => sha256(JSON.stringify(catalog));

export interface Candidate { sha: string; treeHash: string }
export function gitCandidate(root: string = REPO_ROOT): Candidate {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", "src/core/properties") !== "") throw new Error("candidate code has uncommitted changes under src/core/properties");
  return { sha: git("rev-parse", "HEAD"), treeHash: git("rev-parse", "HEAD:src/core/properties") };
}

// ---- Exclusions (§2) --------------------------------------------------------

export interface Exclusions { sessions: string[]; sourceIdentities: string[]; assertionKeys: string[] }
interface T1130Case { type: string; sourceId: string; fact?: { kind: string; subject: string; predicate: string; value: string } }

const identityOf = (runtime: string, runtimeSessionId: string | null): string => `${runtime.split("/")[0]}\u0000${runtimeSessionId ?? ""}`;

export function buildExclusions(db: Database.Database, tenant: string, sampleFiles: readonly string[]): Exclusions {
  const cases = sampleFiles.flatMap((f) => readJson<{ cases: T1130Case[] }>(f).cases);
  const tc = tenantClause(tenant);
  const rows = db.prepare<unknown[], { id: string; runtime: string; runtime_session_id: string | null; parent_session_id: string | null }>(
    `SELECT id, runtime, runtime_session_id, parent_session_id FROM sessions WHERE ${tc.sql}`).all(tc.param);
  const sessions = new Set(cases.map((c) => c.sourceId));
  const identities = new Set(rows.filter((r) => sessions.has(r.id) && r.runtime_session_id).map((r) => identityOf(r.runtime, r.runtime_session_id)));
  for (const r of rows) if (r.runtime_session_id && identities.has(identityOf(r.runtime, r.runtime_session_id))) sessions.add(r.id);
  const parent = new Map(rows.map((r) => [r.id, r.parent_session_id]));
  const children = new Map<string, string[]>();
  for (const r of rows) if (r.parent_session_id) children.set(r.parent_session_id, [...(children.get(r.parent_session_id) ?? []), r.id]);
  const walk = (start: string, next: (id: string) => readonly (string | null | undefined)[]) => {
    for (const queue = [start]; queue.length > 0;) for (const n of next(queue.pop()!)) if (n && !sessions.has(n)) { sessions.add(n); queue.push(n); }
  };
  for (const id of [...sessions]) { walk(id, (x) => [parent.get(x)]); walk(id, (x) => children.get(x) ?? []); }
  const keys = new Set<string>();
  const ft = tenantClause(tenant, "f.tenant_id");
  const factsOf = db.prepare<unknown[], { kind: string; subject: string; predicate: string; value: string; source_quote: string | null; body_version: string | null }>(
    `SELECT f.kind, f.subject, f.predicate, f.value, f.source_quote, s.body_version FROM facts f JOIN sessions s ON s.id = f.source_session_id WHERE f.source_session_id = ? AND ${ft.sql}`);
  for (const c of cases) {
    if (!c.fact) continue;
    for (const row of factsOf.all(c.sourceId, ft.param)) {
      if (row.kind === c.fact.kind && row.subject === c.fact.subject && row.predicate === c.fact.predicate && cleanedEqual(row.value, c.fact.value)) {
        keys.add(assertionKey({ kind: row.kind as Fact["kind"], subject: row.subject, predicate: row.predicate, value: row.value, sourceQuote: row.source_quote }, row.body_version));
      }
    }
  }
  return { sessions: [...sessions].sort(), sourceIdentities: [...identities].sort(), assertionKeys: [...keys].sort() };
}
const cleanedEqual = (raw: string, labelled: string): boolean => clean(raw) === labelled;

interface SessionRow {
  id: string; runtime: string; runtime_session_id: string | null; parent_session_id: string | null; created_at: string;
  label: string; summary: string; body: string | null; body_version: string | null; skill: string | null; status: string;
}

class Disjointness {
  private readonly sessions: Set<string>; private readonly identities: Set<string>; private readonly keys: Set<string>;
  constructor(exclusions: Exclusions, private readonly parent: ReadonlyMap<string, string | null>, private readonly session: ReadonlyMap<string, SessionRow>) {
    this.sessions = new Set(exclusions.sessions); this.identities = new Set(exclusions.sourceIdentities); this.keys = new Set(exclusions.assertionKeys);
  }
  admissible(id: string): boolean {
    const row = this.session.get(id);
    if (row && this.identities.has(identityOf(row.runtime, row.runtime_session_id))) return false;
    for (let at: string | null | undefined = id, hops = 0; at && hops < 1000; at = this.parent.get(at), hops++) if (this.sessions.has(at)) return false;
    return true;
  }
  assertion(key: string): boolean { return !this.keys.has(key); }
}

// ---- Candidate run ----------------------------------------------------------

export interface FactRef { id: string; sessionId: string; kind: string; subject: string; predicate: string; value: string; quote: string | null; assertionKey: string }
export interface FactProposal extends FactRef { slug: string; source: string }
export interface CandidateRun {
  eligibleFacts: number; proposals: FactProposal[]; abstained: FactRef[];
  refsBySession: Map<string, string[]>; sessionsWithEntities: number; sessions: Map<string, SessionRow>; repoScope: Map<string, string>; hasRepositoryOrExplicit: Set<string>;
  disjoint: Disjointness;
}

/** Runs the candidate through its exported functions only, on sessions created after `freezeAt`. */
export function runCandidate(db: Database.Database, catalog: readonly MemoryProperty[], tenant: string, freezeAt: string, exclusions: Exclusions): CandidateRun {
  const st = tenantClause(tenant, "s.tenant_id"); const ft = tenantClause(tenant, "f.tenant_id"); const tc = tenantClause(tenant);
  const sessionRows = db.prepare<unknown[], SessionRow>(
    `SELECT s.id, s.runtime, s.runtime_session_id, s.parent_session_id, s.created_at, s.label, s.summary, s.body, s.body_version, s.skill, s.status FROM sessions s WHERE ${st.sql}`).all(st.param);
  const sessions = new Map(sessionRows.map((r) => [r.id, r]));
  const disjoint = new Disjointness(exclusions, new Map(sessionRows.map((r) => [r.id, r.parent_session_id])), sessions);
  const inWindow = (id: string): boolean => {
    const s = sessions.get(id);
    return !!s && s.status !== "replaced" && Date.parse(s.created_at.includes("T") ? s.created_at : `${s.created_at.replace(" ", "T")}Z`) > Date.parse(freezeAt) && disjoint.admissible(id);
  };
  type Row = SourceAnchorRow & { id: string; kind: Fact["kind"]; subject: string; predicate: string; value: string; source_session_id: string; source_quote: string | null; confidence: number; created_at: string };
  const rows = db.prepare<unknown[], Row>(`SELECT f.*, s.body_version AS current_source_body_version FROM facts f JOIN sessions s ON s.id = f.source_session_id
    WHERE ${ft.sql} AND ${st.sql} AND f.superseded_by IS NULL AND f.retired_at IS NULL AND f.confidence >= 0.6`).all(ft.param, st.param).filter((r) => inWindow(r.source_session_id));
  const bySession = new Map<string, Row[]>();
  for (const r of rows) bySession.set(r.source_session_id, [...(bySession.get(r.source_session_id) ?? []), r]);
  // The candidate reads each session's body to exclude quoted regions, so it runs once per source session.
  const attributed = [...bySession].flatMap(([sessionId, group]) => attributeFacts(group.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, predicate: r.predicate, value: r.value, sourceSessionId: r.source_session_id,
    sourceQuote: r.source_quote, sourceAnchor: anchorFromRow(r, r.source_quote), confidence: r.confidence, createdAt: r.created_at, supersededBy: null })), catalog, [], true, sessions.get(sessionId)?.body_version ?? null, sessions.get(sessionId)?.body ?? null));
  const ref = (f: Fact): FactRef => ({ id: f.id, sessionId: f.sourceSessionId, kind: f.kind, subject: f.subject, predicate: f.predicate, value: f.value, quote: f.sourceQuote ?? null,
    assertionKey: assertionKey(f, sessions.get(f.sourceSessionId)?.body_version ?? null) });
  const proposals: FactProposal[] = []; const abstained: FactRef[] = [];
  for (const f of attributed) {
    const r = ref(f);
    if (f.property?.slug && (f.property.source === "subject" || f.property.source === "source-quote")) {
      if (disjoint.assertion(r.assertionKey)) proposals.push({ ...r, slug: f.property.slug, source: f.property.source });
    } else if (disjoint.assertion(r.assertionKey)) abstained.push(r);
  }
  const entityRows = db.prepare<unknown[], { session_id: string; entity_canonical: string }>(`SELECT session_id, entity_canonical FROM session_entities WHERE ${tc.sql}`).all(tc.param);
  const entities = new Map<string, string[]>();
  for (const e of entityRows) if (inWindow(e.session_id)) entities.set(e.session_id, [...(entities.get(e.session_id) ?? []), e.entity_canonical]);
  const refsBySession = new Map<string, string[]>();
  for (const [id, names] of entities) { const slugs = sessionPropertyReferences(names, catalog, sessions.get(id)?.body ?? null).map((r) => r.slug); if (slugs.length > 0) refsBySession.set(id, slugs); }
  const repoScope = new Map<string, string>(); const hasRepositoryOrExplicit = new Set<string>();
  for (const r of db.prepare<unknown[], { session_id: string; source: string; evidence: string }>(`SELECT session_id, source, evidence FROM session_properties WHERE ${tc.sql}`).all(tc.param)) {
    if (r.source !== "entity") hasRepositoryOrExplicit.add(r.session_id);
    if (r.source === "repository") repoScope.set(r.session_id, r.evidence.split("/").filter(Boolean).pop() ?? r.evidence);
  }
  return { eligibleFacts: rows.length, proposals, abstained, refsBySession, sessionsWithEntities: entities.size, sessions, repoScope, hasRepositoryOrExplicit, disjoint };
}

// ---- Freeze (§4 steps 1-3) --------------------------------------------------

export interface FreezeOptions { snapshot: string; catalogPath: string; dir: string; tenant: string; sampleFiles: readonly string[]; now: Date; candidate: Candidate; lanes?: readonly string[]; live?: string }

export function freezeHoldout(o: FreezeOptions): Manifest {
  const p = pathsIn(o.dir);
  if ((o.lanes ?? LANES).join() !== LANES.join()) throw new Error(`unsupported lanes: only ${LANES.join(", ")} is supported`);
  if (existsSync(p.manifest)) throw new Error("manifest.json already exists: a frozen run is never refrozen");
  assertSnapshot(o.snapshot, o.live);
  const catalog = loadCatalog(o.catalogPath);
  const db = new Database(o.snapshot, { readonly: true, fileMustExist: true });
  let exclusions: Exclusions;
  try { exclusions = buildExclusions(db, o.tenant, o.sampleFiles); } finally { db.close(); }
  privateDirectory(o.dir);
  const exclusionsHash = writePrivate(p.exclusions, exclusions);
  writePrivate(p.catalog, catalog);
  const freezeAt = o.now.toISOString();
  const manifest: Manifest = {
    seed: SEED, freezeAt, lanes: LANES,
    windowCloseRule: { ...WINDOW_RULE, closesNoLaterThan: new Date(o.now.getTime() + WINDOW_RULE.maxDays * 86_400_000).toISOString() },
    candidate: o.candidate, catalogHash: catalogHash(catalog), strataHash: fileHash(STRATA_PATH), cardGeneratorHash: fileHash(CARDS_PATH), l2PromptHash: fileHash(L2_PROMPT_PATH),
    exclusions: { hash: exclusionsHash, sessions: exclusions.sessions.length, sourceIdentities: exclusions.sourceIdentities.length, assertionKeys: exclusions.assertionKeys.length },
  };
  writePrivate(p.manifest, manifest);
  return manifest;
}

/** Re-derives every frozen value; any difference is contamination (§4). */
export function verifyFrozen(dir: string, catalog: readonly MemoryProperty[], candidate: Candidate): { manifest: Manifest; exclusions: Exclusions } {
  const p = pathsIn(dir);
  const manifest = readJson<Manifest>(p.manifest);
  const problems: string[] = [];
  if (manifest.candidate.sha !== candidate.sha || manifest.candidate.treeHash !== candidate.treeHash) problems.push("candidate code changed since freeze");
  if (manifest.catalogHash !== catalogHash(catalog)) problems.push("catalog changed since freeze");
  if (manifest.strataHash !== fileHash(STRATA_PATH)) problems.push("stratum predicates changed since freeze");
  if (manifest.cardGeneratorHash !== fileHash(CARDS_PATH)) problems.push("card generator changed since freeze");
  if (manifest.l2PromptHash !== fileHash(L2_PROMPT_PATH)) problems.push("L2 prompt changed since freeze");
  if (manifest.exclusions.hash !== fileHash(p.exclusions)) problems.push("exclusions.json changed since freeze");
  if (problems.length > 0) throw new Error(`run voided: ${problems.join("; ")}`);
  return { manifest, exclusions: readJson<Exclusions>(p.exclusions) };
}

/** The only window-census path: returns the labellable session references available across the strata targets and nothing else. */
export function countSessionRefs(snapshot: string, catalogPath: string, dir: string, tenant: string, candidate: Candidate, live?: string): number {
  assertSnapshot(snapshot, live);
  const catalog = loadCatalog(catalogPath);
  const { manifest, exclusions } = verifyFrozen(dir, catalog, candidate);
  const db = new Database(snapshot, { readonly: true, fileMustExist: true });
  try { return availableSessionRefs(sessionPoolOf(runCandidate(db, catalog, tenant, manifest.freezeAt, exclusions))); } finally { db.close(); }
}

// ---- Draw (§2, §3, §4 step 4) -----------------------------------------------

export interface PredictionEntry {
  type: "fact" | "session"; lane: "fact" | "session" | "abstention"; stratum: string; sourceId: string; sourceHash: string;
  runtime: string; repoScope: string; proposed: string[];
}
export interface Predictions {
  seed: string; cards: Record<string, PredictionEntry>;
  population: NonNullable<Manifest["draw"]>["population"];
  quotas: Record<string, { required: number; actual: number; met: boolean }>;
  overlap: Record<string, number>; shortfalls: { stratum: string; wanted: number; available: number }[];
}
export interface DrawOptions { snapshot: string; catalogPath: string; dir: string; tenant: string; now: Date; candidate: Candidate; live?: string }

function takeRefs<T extends { refs: number }>(pool: readonly T[], target: number): T[] {
  const taken: T[] = []; let total = 0;
  for (const s of pool) { if (total >= target) break; taken.push(s); total += s.refs; }
  return taken;
}

interface PoolEntry { id: string; slugs: string[]; refs: number; stratum: SessionStratum; overlapping: boolean }

function sessionPoolOf(run: CandidateRun): PoolEntry[] {
  return [...run.refsBySession].map(([id, slugs]) => {
    const s = run.sessions.get(id)!;
    const matches = sessionMatches({ session: { skill: s.skill, label: s.label, body: s.body ?? "" }, hasRepositoryOrExplicit: run.hasRepositoryOrExplicit.has(id) });
    return { id, slugs, refs: slugs.length, stratum: matches[0]!, overlapping: matches.length > 2 };
  });
}
/** References a labeller can reach: each stratum contributes at most its target. */
function availableSessionRefs(pool: readonly PoolEntry[]): number {
  return (Object.keys(SESSION_TARGETS) as SessionStratum[]).reduce((n, stratum) => n + Math.min(SESSION_TARGETS[stratum], pool.filter((e) => e.stratum === stratum).reduce((m, e) => m + e.refs, 0)), 0);
}

export function drawHoldout(o: DrawOptions): Manifest {
  const p = pathsIn(o.dir);
  assertSnapshot(o.snapshot, o.live);
  const catalog = loadCatalog(o.catalogPath);
  const { manifest, exclusions } = verifyFrozen(o.dir, catalog, o.candidate);
  if (manifest.draw) throw new Error("already drawn: a window is drawn once");
  const db = new Database(o.snapshot, { readonly: true, fileMustExist: true });
  let run: CandidateRun;
  try { run = runCandidate(db, catalog, o.tenant, manifest.freezeAt, exclusions); } finally { db.close(); }
  const sessionPool = sessionPoolOf(run);
  const available = availableSessionRefs(sessionPool);
  const closed = available >= manifest.windowCloseRule.minSessionRefs || o.now.getTime() >= Date.parse(manifest.windowCloseRule.closesNoLaterThan);
  if (!closed) throw new Error(`window still open: ${available} of ${manifest.windowCloseRule.minSessionRefs} session references, closes no later than ${manifest.windowCloseRule.closesNoLaterThan}`);

  const bodyOf = (id: string): string => run.sessions.get(id)?.body ?? "";
  const sessionOf = (id: string) => { const s = run.sessions.get(id)!; return { skill: s.skill, label: s.label, body: s.body ?? "" }; };
  type Draft = { key: string; entry: Omit<PredictionEntry, "sourceHash"> & { sourceHash?: string }; card: (id: string) => Card };
  const drafts: Draft[] = [];
  const repoOf = (id: string) => run.repoScope.get(id) ?? "unknown";

  const overlap: Record<string, number> = { session: sessionPool.filter((x) => x.overlapping).length };
  const sessionPopulation: Record<string, number> = { C: 0, D: 0, E: 0 };
  for (const s of sessionPool) sessionPopulation[s.stratum]! += s.refs;
  const shortfalls: Predictions["shortfalls"] = [];
  const minority = (id: string) => MINORITY_RUNTIMES.has(runtimeFamily(run.sessions.get(id)!.runtime));
  const picks: Record<string, PoolEntry[]> = {};
  for (const stratum of ["C", "D", "E"] as const) {
    const pool = ordered(sessionPool.filter((s) => s.stratum === stratum), (s) => s.id, "session:");
    picks[stratum] = stratum === "D"
      ? [...takeRefs(pool.filter((s) => s.refs > 1), 50), ...takeRefs(pool.filter((s) => s.refs === 1), 50)]
      : takeRefs(pool, SESSION_TARGETS[stratum]);
    const got = picks[stratum]!.reduce((n, s) => n + s.refs, 0);
    if (got < SESSION_TARGETS[stratum]) shortfalls.push({ stratum, wanted: SESSION_TARGETS[stratum], available: got });
  }
  let selectedMinority = Object.values(picks).flat().filter((s) => minority(s.id)).length;
  for (const stratum of ["D", "E", "C"] as const) {
    const chosen = new Set(picks[stratum]!.map((s) => s.id));
    const spare = ordered(sessionPool.filter((s) => s.stratum === stratum && !chosen.has(s.id) && minority(s.id)), (s) => s.id, "session:");
    for (let i = picks[stratum]!.length - 1; i >= 0 && selectedMinority < SESSION_MINORITY_QUOTA && spare.length > 0; i--) {
      if (minority(picks[stratum]![i]!.id)) continue;
      picks[stratum]![i] = spare.shift()!; selectedMinority++;
    }
  }
  for (const [stratum, list] of Object.entries(picks)) for (const s of list) {
    const row = run.sessions.get(s.id)!;
    drafts.push({ key: `session:${s.id}`, entry: { type: "session", lane: "session", stratum, sourceId: s.id, sourceHash: sha256(bodyOf(s.id)), runtime: row.runtime, repoScope: repoOf(s.id), proposed: s.slugs },
      card: (id) => sessionCard(id, { label: row.label, summary: row.summary, body: bodyOf(s.id), runtime: row.runtime }, catalog) });
  }

  const abstentions = ordered(run.abstained.filter((f) => (run.refsBySession.get(f.sessionId)?.length ?? 0) > 1), (f) => f.id, "abstain:").slice(0, ABSTENTION_CARDS);
  for (const f of abstentions) {
    const s = run.sessions.get(f.sessionId)!;
    drafts.push({ key: `abstention:${f.id}`, entry: { type: "fact", lane: "abstention", stratum: "abstention", sourceId: f.sessionId, sourceHash: sha256(bodyOf(f.sessionId)), runtime: s.runtime, repoScope: repoOf(f.sessionId), proposed: [] },
      card: (id) => factCard(id, { ...f, body: bodyOf(f.sessionId), runtime: s.runtime }, catalog) });
  }
  if (abstentions.length < ABSTENTION_CARDS) shortfalls.push({ stratum: "abstention", wanted: ABSTENTION_CARDS, available: abstentions.length });

  const shuffled = ordered(drafts, (d) => d.key, "card:");
  const cards: Card[] = []; const entries: Record<string, PredictionEntry> = {};
  shuffled.forEach((d, i) => {
    const id = `c${String(i + 1).padStart(4, "0")}`;
    cards.push(d.card(id)); entries[id] = d.entry as PredictionEntry;
  });
  const cardsHash = writePrivate(p.cards, { seed: SEED, cards });

  const minorityCards = Object.values(entries).filter((e) => e.type === "session" && MINORITY_RUNTIMES.has(runtimeFamily(e.runtime))).length;
  const population = { eligibleFacts: run.eligibleFacts, sessionsWithEntities: run.sessionsWithEntities, sessionRefs: sessionPopulation };
  const predictions: Predictions = {
    seed: SEED, cards: entries, population,
    quotas: { sessionMinorityRuntime: { required: SESSION_MINORITY_QUOTA, actual: minorityCards, met: minorityCards >= SESSION_MINORITY_QUOTA } },
    overlap, shortfalls,
  };
  const predictionsHash = writePrivate(p.predictions, predictions);
  const drawn: Manifest = { ...manifest, draw: { drawnAt: o.now.toISOString(), cardsHash, predictionsHash, snapshot: { path: o.snapshot, bytes: statSync(o.snapshot).size }, population, flags: [] } };
  writePrivate(p.manifest, drawn);
  return drawn;
}
