import { describe, it, expect } from "vitest";
import {
  computeReDerivationRate,
  parseReDerivationPairsFile,
  type ReDerivationDeps,
} from "@core/metrics/re-derivation.js";

interface FakeSession {
  id: string;
  startedAt: string;
  entities: ReadonlyArray<string>;
  decisions: ReadonlyArray<string>;
}

interface FakeEdge {
  from_session: string;
  to_session: string;
  kind: string;
}

function makeFakeDeps(
  sessions: ReadonlyArray<FakeSession>,
  edges: ReadonlyArray<FakeEdge>,
): ReDerivationDeps {
  return {
    listSessionsWithin: async () => sessions,
    listEdges: async () => edges,
  };
}

describe("computeReDerivationRate", () => {
  it("counts same-topic decisions re-made across sessions with no continues edge", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector over qdrant"] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector over qdrant"] },
      ],
      [],
    );
    const { rate, pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(1);
    expect(rate).toBeGreaterThan(0);
  });

  it("does NOT count when a continues edge links them", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector"] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector"] },
      ],
      [{ from_session: "b", to_session: "a", kind: "continues" }],
    );
    const { pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
  });

  it("does NOT count when a supersedes edge links them", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector"] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector"] },
      ],
      [{ from_session: "b", to_session: "a", kind: "supersedes" }],
    );
    const { pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
  });

  it("does NOT count when sessions share no entity (continues past non-overlap, no early return)", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["alpha"], decisions: ["pick alpha"] },
        { id: "b", startedAt: "2026-01-15", entities: ["beta"], decisions: ["pick beta"] },
        { id: "c", startedAt: "2026-02-01", entities: ["beta"], decisions: ["pick beta"] },
      ],
      [],
    );
    const { pairs } = await computeReDerivationRate(deps, 90);
    // a shares nothing with b or c; b<->c share "beta" and re-derive.
    // A buggy early-return on the first non-overlapping pair would miss b<->c.
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.a).toBe("b");
    expect(pairs[0]!.b).toBe("c");
  });

  it("does NOT count when the time gap is within the window threshold", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector"] },
        { id: "b", startedAt: "2026-01-05", entities: ["pgvector"], decisions: ["use pgvector"] },
      ],
      [],
    );
    const { pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
  });

  it("does NOT count when decisions diverge below the Jaccard floor", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector for embeddings"] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["drop the cache entirely"] },
      ],
      [],
    );
    const { pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
  });
});

describe("denominator: decisionless sessions can never be a positive", () => {
  it("excludes a pair whose earlier side carries no decisions", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: [] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector"] },
      ],
      [],
    );
    const { eligible, pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
    expect(eligible).toBe(0);
  });

  it("excludes a pair whose later side carries no decisions", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector"] },
        { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: [] },
      ],
      [],
    );
    expect((await computeReDerivationRate(deps, 90)).eligible).toBe(0);
  });

  it("still counts a pair when both sides carry decisions, even with no overlap", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["x"], decisions: ["alpha"] },
        { id: "b", startedAt: "2026-01-15", entities: ["x"], decisions: ["zeta"] },
      ],
      [],
    );
    const { eligible, pairs } = await computeReDerivationRate(deps, 90);
    expect(eligible).toBe(1);
    expect(pairs.length).toBe(0);
  });
});

describe("session-level rate", () => {
  it("divides re-deriving sessions by decision-bearing sessions, not by pairs", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["e"], decisions: ["use pgvector over qdrant"] },
        { id: "b", startedAt: "2026-01-15", entities: ["e"], decisions: ["use pgvector over qdrant"] },
        { id: "c", startedAt: "2026-01-20", entities: ["e"], decisions: ["something else entirely"] },
        { id: "d", startedAt: "2026-01-21", entities: ["e"], decisions: [] },
      ],
      [],
    );
    const r = await computeReDerivationRate(deps, 90);
    expect(r.decisionBearingSessions).toBe(3);
    expect(r.reDerivingSessions).toBe(1);
    expect(r.sessionRate).toBeCloseTo(1 / 3);
  });

  it("counts the later session once even when it re-derives several earlier ones", async () => {
    const deps = makeFakeDeps(
      [
        { id: "a", startedAt: "2026-01-01", entities: ["e"], decisions: ["use pgvector"] },
        { id: "b", startedAt: "2026-01-10", entities: ["e"], decisions: ["use pgvector"] },
        { id: "c", startedAt: "2026-01-20", entities: ["e"], decisions: ["use pgvector"] },
      ],
      [],
    );
    const r = await computeReDerivationRate(deps, 90);
    expect(r.pairs.length).toBe(3);
    expect(r.reDerivingSessions).toBe(2);
  });

  it("is 0, not NaN, when no session carries a decision", async () => {
    const deps = makeFakeDeps(
      [{ id: "a", startedAt: "2026-01-01", entities: ["e"], decisions: [] }],
      [],
    );
    const r = await computeReDerivationRate(deps, 90);
    expect(r.decisionBearingSessions).toBe(0);
    expect(r.sessionRate).toBe(0);
  });
});

describe("parseReDerivationPairsFile", () => {
  it("parses a valid pairs array", () => {
    const pairs = [{ a: "s1", b: "s2", sharedEntities: ["pgvector"], jaccard: 0.75 }];
    expect(parseReDerivationPairsFile(JSON.stringify(pairs))).toEqual(pairs);
  });

  it("throws on corrupt JSON - the file-read caller is responsible for the [] fallback", () => {
    expect(() => parseReDerivationPairsFile("{not json")).toThrow();
  });

  it("returns [] for a valid JSON non-array shape", () => {
    expect(parseReDerivationPairsFile(JSON.stringify({ oops: true }))).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseReDerivationPairsFile("[]")).toEqual([]);
  });
});
