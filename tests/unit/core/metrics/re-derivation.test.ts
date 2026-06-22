import { describe, it, expect } from "vitest";
import {
  computeReDerivationRate,
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
