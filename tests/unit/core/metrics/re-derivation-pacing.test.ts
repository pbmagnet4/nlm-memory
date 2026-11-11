/**
 * T679 Part 3 — the re-derivation recompute used to run the whole 42-day window
 * (17,244 sessions on the live corpus) in one synchronous slice, which froze the
 * serving event loop for minutes at a time. Batching and hoisting the per-session
 * work is only acceptable if the report is unchanged, so these tests hold the
 * pre-T679 implementation as the oracle and compare against it, including on
 * pseudo-random fixtures with duplicate entities, decisionless sessions, edges,
 * near-7-day gaps and unparseable timestamps.
 */

import { describe, expect, it } from "vitest";
import {
  RE_DERIVATION_ENRICH_BATCH_ROWS,
  computeReDerivationRate,
  sqliteReDerivationDeps,
  type ReDerivationDeps,
  type ReDerivationPair,
  type ReDerivationReport,
} from "@core/metrics/re-derivation.js";

interface FixtureSession {
  id: string;
  startedAt: string;
  entities: ReadonlyArray<string>;
  decisions: ReadonlyArray<string>;
}

interface FixtureEdge {
  from_session: string;
  to_session: string;
  kind: string;
}

const GAP_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const JACCARD_FLOOR = 0.5;

/** Verbatim pre-T679 `computeReDerivationRate` (src/core/metrics/re-derivation.ts
 *  as of commit cb48e9b), kept here as the equivalence oracle. Not a re-use: if
 *  this and the implementation agree, the refactor preserved the semantics. */
async function referenceRate(deps: ReDerivationDeps, windowDays: number): Promise<ReDerivationReport> {
  const sessions = await deps.listSessionsWithin(windowDays);
  const edges = await deps.listEdges();
  const linked = new Set(
    edges
      .filter((e) => e.kind === "continues" || e.kind === "supersedes")
      .map((e) => [e.from_session, e.to_session].sort().join("|")),
  );
  function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
    const toks = (xs: ReadonlyArray<string>): Set<string> =>
      new Set(xs.join(" ").toLowerCase().split(/\W+/).filter(Boolean));
    const A = toks(a);
    const B = toks(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const pairs: ReDerivationPair[] = [];
  const reDeriving = new Set<string>();
  let eligible = 0;
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s = sessions[i]!;
      const t = sessions[j]!;
      if (s.decisions.length === 0 || t.decisions.length === 0) continue;
      const shared = s.entities.filter((e) => t.entities.includes(e));
      if (shared.length === 0) continue;
      eligible++;
      const key = [s.id, t.id].sort().join("|");
      if (linked.has(key)) continue;
      const gap = Math.abs(new Date(t.startedAt).getTime() - new Date(s.startedAt).getTime()) / MS_PER_DAY;
      if (gap <= GAP_DAYS) continue;
      const jac = jaccard(s.decisions, t.decisions);
      if (jac >= JACCARD_FLOOR) {
        pairs.push({ a: s.id, b: t.id, sharedEntities: shared, jaccard: round2(jac) });
        const later =
          new Date(t.startedAt).getTime() >= new Date(s.startedAt).getTime() ? t.id : s.id;
        reDeriving.add(later);
      }
    }
  }
  const decisionBearingSessions = sessions.filter((s) => s.decisions.length > 0).length;
  return {
    rate: eligible ? pairs.length / eligible : 0,
    pairs,
    eligible,
    decisionBearingSessions,
    reDerivingSessions: reDeriving.size,
    sessionRate: decisionBearingSessions ? reDeriving.size / decisionBearingSessions : 0,
  };
}

const depsOf = (
  sessions: ReadonlyArray<FixtureSession>,
  edges: ReadonlyArray<FixtureEdge>,
): ReDerivationDeps => ({
  listSessionsWithin: async () => sessions,
  listEdges: async () => edges,
});

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomFixture(seed: number, count: number): {
  sessions: FixtureSession[];
  edges: FixtureEdge[];
} {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length) % xs.length]!;
  const entities = ["pgvector", "sqlite-vec", "lm studio", "wal", "hooks", "omlx"];
  const phrasetBank = [
    "use pgvector over qdrant for the index",
    "keep sqlite-vec as the vector store",
    "bound the wal with a periodic checkpoint",
    "ship the hooks behind a flag",
    "route embeddings to lm studio first",
  ];
  const days = ["2026-01-01", "2026-01-05", "2026-01-09", "2026-01-20", "2026-02-02", "not-a-date", ""];
  const sessions: FixtureSession[] = [];
  for (let i = 0; i < count; i++) {
    const nEnt = Math.floor(rand() * 3);
    const nDec = rand() < 0.35 ? 0 : 1 + Math.floor(rand() * 2);
    sessions.push({
      id: `s${String(i).padStart(3, "0")}`,
      startedAt: pick(days),
      // Duplicates on purpose: `sharedEntities` preserving them is part of the contract.
      entities: Array.from({ length: nEnt }, () => pick(entities)),
      decisions: Array.from({ length: nDec }, () => pick(phrasetBank)),
    });
  }
  const edges: FixtureEdge[] = [];
  for (let i = 0; i < count / 3; i++) {
    edges.push({
      from_session: pick(sessions).id,
      to_session: pick(sessions).id,
      kind: pick(["continues", "supersedes", "mentions"]),
    });
  }
  return { sessions, edges };
}

describe("computeReDerivationRate equivalence with the pre-T679 implementation", () => {
  it("agrees on a hand-built fixture covering every gate", async () => {
    const sessions: FixtureSession[] = [
      { id: "a", startedAt: "2026-01-01", entities: ["wal", "wal", "hooks"], decisions: ["bound the wal with a periodic checkpoint"] },
      { id: "b", startedAt: "2026-01-08", entities: ["wal"], decisions: ["bound the wal with a periodic checkpoint"] },
      { id: "c", startedAt: "2026-02-01", entities: ["wal"], decisions: ["bound the wal with a periodic checkpoint"] },
      { id: "d", startedAt: "2026-02-01", entities: ["omlx"], decisions: [] },
      { id: "e", startedAt: "2026-02-05", entities: [], decisions: ["bound the wal with a periodic checkpoint"] },
      { id: "f", startedAt: "not-a-date", entities: ["wal"], decisions: ["bound the wal with a periodic checkpoint"] },
      { id: "g", startedAt: "2026-02-06", entities: ["wal"], decisions: ["totally unrelated thing here"] },
    ];
    const edges: FixtureEdge[] = [{ from_session: "c", to_session: "a", kind: "continues" }];
    const deps = depsOf(sessions, edges);
    await expect(computeReDerivationRate(deps, 90)).resolves.toEqual(await referenceRate(deps, 90));
  });

  for (const seed of [1, 7, 42, 1234]) {
    it(`agrees on pseudo-random fixture seed=${seed}`, async () => {
      const { sessions, edges } = randomFixture(seed, 40);
      const deps = depsOf(sessions, edges);
      const mine = await computeReDerivationRate(deps, 90);
      const oracle = await referenceRate(deps, 90);
      expect(mine.pairs.length).toBeGreaterThan(0);
      expect(mine.eligible).toBeGreaterThan(0);
      expect(mine).toEqual(oracle);
    });
  }

  it("is unaffected by how often the pair loop yields", async () => {
    const { sessions, edges } = randomFixture(11, 30);
    const deps = depsOf(sessions, edges);
    let yields = 0;
    const paced = await computeReDerivationRate(deps, 90, {
      yieldEveryPairs: 1,
      yieldFn: async () => {
        yields += 1;
      },
    });
    const unpaced = await computeReDerivationRate(deps, 90);
    expect(yields).toBeGreaterThan(0);
    expect(paced).toEqual(unpaced);
  });

  it("gives up its slice periodically with the real yield function", async () => {
    const { sessions } = randomFixture(3, 30);
    const deps = depsOf(sessions, []);
    let timerRan = 0;
    const timer = setInterval(() => {
      timerRan += 1;
    }, 0);
    await computeReDerivationRate(deps, 90, { yieldEveryPairs: 1 });
    clearInterval(timer);
    expect(timerRan).toBeGreaterThan(0);
  });
});

/** Minimal stand-in for the better-sqlite3 handle `sqliteReDerivationDeps` uses. */
function fakeDb(sessions: ReadonlyArray<FixtureSession>) {
  const calls: string[] = [];
  const stmt = (label: string, all: (...args: unknown[]) => unknown[]) => ({
    all(...args: unknown[]) {
      calls.push(label);
      return all(...args);
    },
  });
  const db = {
    prepare(sql: string) {
      if (sql.includes("FROM sessions")) {
        return stmt("sessions", () => sessions.map((s) => ({ id: s.id, startedAt: s.startedAt })));
      }
      if (sql.includes("session_entities")) {
        return stmt("entities", (id: unknown) =>
          sessions.find((s) => s.id === id)?.entities.map((e) => ({ e })) ?? [],
        );
      }
      if (sql.includes("markers")) {
        return stmt("decisions", (id: unknown) =>
          sessions.find((s) => s.id === id)?.decisions.map((t) => ({ t })) ?? [],
        );
      }
      return stmt("edges", () => []);
    },
  };
  return { db, calls };
}

describe("sqliteReDerivationDeps enrichment batching", () => {
  const sessions: FixtureSession[] = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`,
    startedAt: "2026-01-01",
    entities: [`e${i}`],
    decisions: [`d${i}`],
  }));

  it("yields between row batches and returns the same rows in order", async () => {
    const { db } = fakeDb(sessions);
    let yields = 0;
    const deps = sqliteReDerivationDeps(db, "t1", {
      enrichBatchRows: 2,
      yieldFn: async () => {
        yields += 1;
      },
    });
    const batched = await deps.listSessionsWithin(42);
    const unbatched = await sqliteReDerivationDeps(db, "t1").listSessionsWithin(42);
    // ceil(5/2) - 1 = 2 yields between the three batches.
    expect(yields).toBe(2);
    expect(batched).toEqual(unbatched);
    expect(batched.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(batched[0]).toEqual({ id: "s0", startedAt: "2026-01-01", entities: ["e0"], decisions: ["d0"] });
  });

  it("does not yield for a single batch, and defaults to a bounded batch", async () => {
    const { db } = fakeDb(sessions);
    let yields = 0;
    const deps = sqliteReDerivationDeps(db, "t1", {
      yieldFn: async () => {
        yields += 1;
      },
    });
    await deps.listSessionsWithin(42);
    expect(yields).toBe(0);
    expect(RE_DERIVATION_ENRICH_BATCH_ROWS).toBeLessThanOrEqual(500);
  });

  it("produces the same report through the batched deps as the oracle", async () => {
    const { db } = fakeDb(sessions);
    const deps = sqliteReDerivationDeps(db, "t1", { enrichBatchRows: 1 });
    await expect(computeReDerivationRate(deps, 42)).resolves.toEqual(
      await referenceRate(deps, 42),
    );
  });
});
