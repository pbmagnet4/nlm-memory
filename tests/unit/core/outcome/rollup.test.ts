import { describe, it, expect } from "vitest";
import { deriveOutcome } from "@core/outcome/rollup.js";
import type {
  OutcomeCitation,
  OutcomeDeps,
  OutcomeEdge,
  OutcomeSession,
  OutcomeSignal,
} from "@ports/outcome.js";
import type { ReDerivationPair } from "@core/metrics/re-derivation.js";

const SESSION_ID = "sess-a";

function makeDeps(overrides: Partial<OutcomeDeps> & { session?: OutcomeSession | null } = {}): OutcomeDeps {
  const session: OutcomeSession | null =
    overrides.session !== undefined
      ? overrides.session
      : { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" };

  const signals: ReadonlyArray<OutcomeSignal> = [];
  const edges: ReadonlyArray<OutcomeEdge> = [];
  const citations: ReadonlyArray<OutcomeCitation> = [];
  const reDerivationPairs: ReadonlyArray<ReDerivationPair> = [];

  return {
    sessions: { getById: async () => session },
    signals: { listForSession: async () => signals },
    edges: { listForSession: async () => edges },
    citations: { listForSession: async () => citations },
    reDerivationPairs,
    now: () => new Date("2026-01-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveOutcome", () => {
  it("verdict=held when un-superseded 14+ days after endedAt with no other evidence", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-15T00:00:00.000Z"), // exactly 14 days later
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("held");
    expect(verdict.tier).toBe("B");
    expect(verdict.confidence).toBe("medium");
  });

  it("clock boundary: exactly 14 days elapsed counts as held", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-15T00:00:00.000Z"), // 14.0 days exactly
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("held");
  });

  it("clock boundary: 13 days 23:59:59 elapsed does NOT count as held", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-14T23:59:59.000Z"), // one second short of 14 days
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).not.toBe("held");
    expect(verdict.verdict).toBe("unobserved");
  });

  it("verdict=overturned when session status is superseded", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "superseded" },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("overturned");
    expect(verdict.tier).toBe("B");
    expect(verdict.confidence).toBe("high");
  });

  it("verdict=overturned when a supersedes/replaces edge points at this session", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      edges: { listForSession: async () => [{ fromSession: "sess-b", toSession: SESSION_ID, kind: "replaces" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("overturned");
    expect(verdict.evidence.length).toBeGreaterThan(0);
  });

  it("verdict=built-upon when an inbound continues edge exists and session is not yet held-eligible", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"), // only 2 days elapsed, not held-eligible
      edges: { listForSession: async () => [{ fromSession: "sess-c", toSession: SESSION_ID, kind: "continues" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("built-upon");
    expect(verdict.tier).toBe("B");
    expect(verdict.confidence).toBe("medium");
  });

  it("verdict=re-derived-later when session is a member of a re-derivation pair", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"), // not held-eligible, no other evidence
      reDerivationPairs: [{ a: SESSION_ID, b: "sess-d", sharedEntities: ["pgvector"], jaccard: 0.9 }],
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("re-derived-later");
    expect(verdict.confidence).toBe("medium");
  });

  it("verdict=unobserved with no evidence at all", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"),
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("unobserved");
    expect(verdict.confidence).toBe("low");
    expect(verdict.evidence).toEqual([]);
    expect(verdict.producerDegraded).toBeUndefined();
  });

  it("citation-only evidence stays unobserved and sets producerDegraded", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"),
      citations: { listForSession: async () => [{ conversationId: "conv-1" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("unobserved");
    expect(verdict.producerDegraded).toBe(true);
    expect(verdict.evidence).toContain("citation:conv-1");
  });

  it("Tier-A signal evidence wins over heuristics that would otherwise conclude built-upon", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"),
      signals: { listForSession: async () => [{ id: "sig-1", outcome: "pass" }] },
      edges: { listForSession: async () => [{ fromSession: "sess-c", toSession: SESSION_ID, kind: "continues" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("held");
    expect(verdict.tier).toBe("A");
    expect(verdict.confidence).toBe("high");
  });

  it("Tier-A signal with a non-pass outcome resolves to overturned, still beating heuristics", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-20T00:00:00.000Z"), // would be held-eligible on heuristics alone
      signals: { listForSession: async () => [{ id: "sig-2", outcome: "fail" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("overturned");
    expect(verdict.tier).toBe("A");
    expect(verdict.confidence).toBe("high");
  });

  it("precedence collision: held (14+ days un-superseded) wins over an inbound continues edge", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-01T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-20T00:00:00.000Z"), // 19 days elapsed, held-eligible
      edges: { listForSession: async () => [{ fromSession: "sess-c", toSession: SESSION_ID, kind: "continues" }] },
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("held");
    expect(verdict.tier).toBe("B");
    expect(verdict.confidence).toBe("medium");
  });

  it("precedence collision: continuation wins over re-derivation-pair membership", async () => {
    const deps = makeDeps({
      session: { id: SESSION_ID, endedAt: "2026-01-10T00:00:00.000Z", status: "closed" },
      now: () => new Date("2026-01-12T00:00:00.000Z"), // not held-eligible
      edges: { listForSession: async () => [{ fromSession: "sess-c", toSession: SESSION_ID, kind: "continues" }] },
      reDerivationPairs: [{ a: SESSION_ID, b: "sess-d", sharedEntities: ["pgvector"], jaccard: 0.9 }],
    });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("built-upon");
    expect(verdict.confidence).toBe("medium");
  });

  it("unknown session id yields unobserved/low with no evidence", async () => {
    const deps = makeDeps({ session: null });

    const verdict = await deriveOutcome(SESSION_ID, deps);

    expect(verdict.verdict).toBe("unobserved");
    expect(verdict.confidence).toBe("low");
    expect(verdict.evidence).toEqual([]);
  });
});
