import { describe, it, expect } from "vitest";
import {
  MIN_RESTATEMENT_TOKENS,
  isMergeEligible,
  proposeFactMerges,
  type FactDedupFact,
} from "@core/dream/fact-dedup.js";

let seq = 0;
function fact(overrides: Partial<FactDedupFact> & { value: string }): FactDedupFact {
  seq += 1;
  return {
    id: `f${seq}`,
    subject: "proj",
    predicate: "db",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("fact-dedup scoring core", () => {
  describe("empty and degenerate inputs", () => {
    it("empty input yields no proposals", () => {
      expect(proposeFactMerges([])).toEqual([]);
    });

    it("a single fact yields no proposals", () => {
      expect(proposeFactMerges([fact({ value: "postgres" })])).toEqual([]);
    });

    it("all-inactive input yields no proposals", () => {
      expect(
        proposeFactMerges([
          fact({ value: "postgres", supersededBy: "x" }),
          fact({ value: "postgres", retiredAt: "2026-02-01T00:00:00Z" }),
        ]),
      ).toEqual([]);
    });

    it("facts with blank triple parts are ineligible", () => {
      expect(isMergeEligible(fact({ value: "   .  " }))).toBe(false);
      expect(isMergeEligible(fact({ subject: " ", value: "postgres" }))).toBe(false);
      expect(isMergeEligible(fact({ predicate: "", value: "postgres" }))).toBe(false);
      expect(isMergeEligible(fact({ value: "postgres" }))).toBe(true);
    });

    it("superseded/retired markers are honoured, nulls are active", () => {
      expect(isMergeEligible(fact({ value: "v", supersededBy: null, retiredAt: null }))).toBe(true);
      expect(isMergeEligible(fact({ value: "v", supersededBy: "other" }))).toBe(false);
      expect(isMergeEligible(fact({ value: "v", retiredAt: "2026-01-02T00:00:00Z" }))).toBe(false);
    });

    it("inactive facts never appear in proposals", () => {
      const dup = fact({ id: "active1", value: "postgres 16", corroborationCount: 1 });
      const dead = fact({ id: "dead1", value: "Postgres 16.", supersededBy: "z" });
      expect(proposeFactMerges([dup, dead])).toEqual([]);
    });
  });

  describe("exact duplicates", () => {
    it("folds case, whitespace and punctuation into one proposal", () => {
      const a = fact({ id: "a", value: "Postgres  16" });
      const b = fact({ id: "b", value: "postgres 16." });
      const props = proposeFactMerges([a, b]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("exact");
      expect(props[0]!.winnerId).toBe("a"); // id tie-break: "a" < "b"
      expect(props[0]!.reason).toContain("fact-dedup exact");
      expect(props[0]!.reason).toContain('equivalent values "postgres 16"');
      expect(props[0]!.reason).toContain("id tie-break");
    });

    it("hyphenated and spaced values are equivalent", () => {
      const props = proposeFactMerges([
        fact({ id: "x", value: "local-first" }),
        fact({ id: "y", value: "Local First" }),
      ]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("exact");
    });

    it("subject/predicate fold is case+whitespace only", () => {
      const props = proposeFactMerges([
        fact({ id: "p", subject: "  Proj ", predicate: "DB", value: "postgres" }),
        fact({ id: "q", subject: "proj", predicate: "db", value: "postgres" }),
      ]);
      expect(props).toHaveLength(1);
      expect(props[0]!.winnerId).toBe("p");
    });

    it("input order never changes the proposal", () => {
      const a = fact({ id: "a", value: "postgres 16" });
      const b = fact({ id: "b", value: "postgres 16", corroborationCount: 3 });
      const one = proposeFactMerges([a, b]);
      const two = proposeFactMerges([b, a]);
      expect(two).toEqual(one);
      expect(one).toHaveLength(1);
    });
  });

  describe("restatements", () => {
    it("whole-token containment proposes a restatement merge", () => {
      const short = fact({ id: "short", value: "lm studio" });
      const long = fact({ id: "long", value: "LM Studio runs as the primary inference lane" });
      const props = proposeFactMerges([short, long]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("restatement");
      expect(props[0]!.winnerId).toBe("long");
      expect(props[0]!.reason).toContain(`restatement "lm studio"`);
      expect(props[0]!.reason).toContain("id tie-break");
    });

    it("contained span need not be a prefix", () => {
      const props = proposeFactMerges([
        fact({ id: "m", value: "ships Tuesday" }),
        fact({ id: "n", value: "the judge ships Tuesday morning" }),
      ]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("restatement");
    });

    it("one-token containment is too weak — no merge", () => {
      const props = proposeFactMerges([
        fact({ id: "w", value: "port" }),
        fact({ id: "z", value: "port 5432" }),
      ]);
      expect(props).toEqual([]);
      expect(MIN_RESTATEMENT_TOKENS).toBe(2);
    });

    it("added numeric token means a distinct facet — no merge", () => {
      const props = proposeFactMerges([
        fact({ id: "v1", value: "windows server 2019" }),
        fact({ id: "v2", value: "windows server 2019 and 2022" }),
      ]);
      expect(props).toEqual([]);
    });

    it("repeated known number does not block the restatement", () => {
      const props = proposeFactMerges([
        fact({ id: "k1", value: "port 5432" }),
        fact({ id: "k2", value: "default port 5432" }),
      ]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("restatement");
    });

    it("added alphanumeric spec token means a distinct facet — no merge", () => {
      const props = proposeFactMerges([
        fact({ id: "s1", value: "mac pro 16gb" }),
        fact({ id: "s2", value: "mac pro 16gb 512gb" }),
      ]);
      expect(props).toEqual([]);
    });

    it("added version-like token blocks the restatement", () => {
      const props = proposeFactMerges([
        fact({ id: "q1", value: "api v2" }),
        fact({ id: "q2", value: "api v2 plus v3" }),
      ]);
      expect(props).toEqual([]);
    });

    it("repeated spec token does not block the restatement", () => {
      const props = proposeFactMerges([
        fact({ id: "r1", value: "mac pro 16gb" }),
        fact({ id: "r2", value: "mac pro 16gb tower" }),
      ]);
      expect(props).toHaveLength(1);
      expect(props[0]!.cls).toBe("restatement");
    });
  });

  describe("distinct facets must NOT merge", () => {
    it("different values on the same subject+predicate stay apart", () => {
      const props = proposeFactMerges([
        fact({ id: "p1", predicate: "port", value: "5432" }),
        fact({ id: "p2", predicate: "port", value: "1234" }),
      ]);
      expect(props).toEqual([]);
    });

    it("sub-token substring overlap stays apart (fast vs fastify)", () => {
      const props = proposeFactMerges([
        fact({ id: "s1", predicate: "framework", value: "fast" }),
        fact({ id: "s2", predicate: "framework", value: "fastify" }),
      ]);
      expect(props).toEqual([]);
    });

    it("same value under different predicate stays apart", () => {
      const props = proposeFactMerges([
        fact({ id: "d1", predicate: "primary db", value: "postgres 16" }),
        fact({ id: "d2", predicate: "cache", value: "postgres 16" }),
      ]);
      expect(props).toEqual([]);
    });

    it("same value under different subject stays apart", () => {
      const props = proposeFactMerges([
        fact({ id: "u1", subject: "app A", value: "postgres 16" }),
        fact({ id: "u2", subject: "app B", value: "postgres 16" }),
      ]);
      expect(props).toEqual([]);
    });

    it("token reordering is not a restatement", () => {
      const props = proposeFactMerges([
        fact({ id: "o1", value: "server windows" }),
        fact({ id: "o2", value: "windows linux server" }),
      ]);
      expect(props).toEqual([]);
    });
  });

  describe("winner/loser tie-breaking", () => {
    it("more corroborated wins even when older", () => {
      const older = fact({ id: "old", value: "postgres", corroborationCount: 4, createdAt: "2025-01-01T00:00:00Z" });
      const newer = fact({ id: "new", value: "Postgres", corroborationCount: 2, createdAt: "2026-06-01T00:00:00Z" });
      const props = proposeFactMerges([newer, older]);
      expect(props).toHaveLength(1);
      expect(props[0]!.winnerId).toBe("old");
      expect(props[0]!.loserId).toBe("new");
      expect(props[0]!.reason).toContain("corroboration 4>2");
    });

    it("corroboration tie → newer createdAt wins", () => {
      const old = fact({ id: "z-old", value: "postgres", corroborationCount: 2, createdAt: "2025-01-01T00:00:00Z" });
      const fresh = fact({ id: "a-new", value: "postgres", corroborationCount: 2, createdAt: "2026-06-01T00:00:00Z" });
      const props = proposeFactMerges([old, fresh]);
      expect(props[0]!.winnerId).toBe("a-new");
      expect(props[0]!.reason).toContain("newer createdAt");
    });

    it("absent corroboration counts as 1", () => {
      const props = proposeFactMerges([
        fact({ id: "plain", value: "postgres" }),
        fact({ id: "single", value: "postgres", corroborationCount: 1 }),
      ]);
      expect(props[0]!.reason).toContain("id tie-break");
      expect(props[0]!.winnerId).toBe("plain");
    });

    it("full tie → lexicographically smaller id wins, both directions", () => {
      const m = fact({ id: "mmm", value: "postgres" });
      const z = fact({ id: "zzz", value: "postgres" });
      expect(proposeFactMerges([m, z])[0]!.winnerId).toBe("mmm");
      expect(proposeFactMerges([z, m])[0]!.winnerId).toBe("mmm");
    });

    it("unparseable timestamps rank below parseable ones", () => {
      const bogus = fact({ id: "b", value: "postgres", createdAt: "not-a-date" });
      const dated = fact({ id: "d", value: "postgres", createdAt: "2020-01-01T00:00:00Z" });
      const props = proposeFactMerges([bogus, dated]);
      expect(props[0]!.winnerId).toBe("d");
      expect(props[0]!.reason).toContain("newer createdAt");
    });

    it("both timestamps unparseable → id tie-break", () => {
      const props = proposeFactMerges([
        fact({ id: "g1", value: "postgres", createdAt: "yesterday" }),
        fact({ id: "g2", value: "postgres", createdAt: "whenever" }),
      ]);
      expect(props[0]!.winnerId).toBe("g1");
      expect(props[0]!.reason).toContain("id tie-break");
    });
  });

  describe("grouping and chain control", () => {
    it("a hub exact group merges everyone into one winner", () => {
      const props = proposeFactMerges([
        fact({ id: "h1", value: "postgres 16", corroborationCount: 5 }),
        fact({ id: "h2", value: "Postgres 16" }),
        fact({ id: "h3", value: "postgres-16" }),
      ]);
      expect(props).toHaveLength(2);
      expect(props.every((p) => p.winnerId === "h1" && p.cls === "exact")).toBe(true);
      expect(props.map((p) => p.loserId).sort()).toEqual(["h2", "h3"]);
    });

    it("a loser never reappears as winner or loser — no chains", () => {
      // a ≡ b (exact), then a ~ c (restatement): a wins both, so every
      // proposal points at the surviving hub — a loser never reappears.
      const props = proposeFactMerges([
        fact({ id: "a", value: "lm studio" }),
        fact({ id: "b", value: "LM Studio" }),
        fact({ id: "c", value: "LM Studio serves ollama models" }),
      ]);
      // a vs b: exact, id tie-break → a wins, b is out; b-vs-c is skipped
      // entirely (b already lost), only the surviving a-vs-c restatement fires.
      expect(props).toHaveLength(2);
      expect(props.every((p) => p.winnerId === "a")).toBe(true);
      expect(props.map((p) => p.loserId)).toEqual(["b", "c"]);
      for (const p of props) {
        expect(props.filter((q) => q.loserId === p.loserId)).toHaveLength(1);
      }
      const ids = new Set(props.map((p) => p.winnerId));
      for (const p of props) expect(ids.has(p.loserId)).toBe(false);
    });

    it("graded corroboration elects one hub — no transitive chains", () => {
      // Repro: fold-equal triple, corroboration rising with id order. The old
      // pair scan emitted {winner:b,loser:a} then {winner:c,loser:b}, leaving
      // a pointing at the superseded b. One hub (c) must win both.
      const props = proposeFactMerges([
        fact({ id: "a", value: "postgres 16", corroborationCount: 1 }),
        fact({ id: "b", value: "Postgres 16.", corroborationCount: 5 }),
        fact({ id: "c", value: "postgres-16", corroborationCount: 10 }),
      ]);
      expect(props).toHaveLength(2);
      expect(props.every((p) => p.winnerId === "c" && p.cls === "exact")).toBe(true);
      expect(props.map((p) => p.loserId).sort()).toEqual(["a", "b"]);
      const winners = new Set(props.map((p) => p.winnerId));
      for (const p of props) expect(winners.has(p.loserId)).toBe(false);
    });

    it("exact proposals are emitted before restatements in a group", () => {
      const props = proposeFactMerges([
        fact({ id: "z1", value: "redis cache" }),
        fact({ id: "z2", value: "Redis Cache" }),
        fact({ id: "z3", value: "redis cache on the mac pro" }),
      ]);
      expect(props.map((p) => p.cls)).toEqual(["exact", "restatement"]);
      // z1 beats z2 (exact, id tie-break); the surviving z1 then faces z3:
      // restatement, id tie-break → z1 wins.
      expect(props[0]).toMatchObject({ winnerId: "z1", loserId: "z2" });
      expect(props[1]).toMatchObject({ winnerId: "z1", loserId: "z3" });
    });

    it("independent subject+predicate groups are all covered, emitted in sorted key order", () => {
      const props = proposeFactMerges([
        fact({ id: "q1", subject: "zeta", value: "kafka" }),
        fact({ id: "q2", subject: "zeta", value: "Kafka" }),
        fact({ id: "q3", subject: "alpha", predicate: "queue", value: "kafka" }),
        fact({ id: "q4", subject: "alpha", predicate: "queue", value: "kafka" }),
      ]);
      expect(props).toHaveLength(2);
      expect(props[0]!.reason).toContain('"alpha queue"');
      expect(props[1]!.reason).toContain('"zeta db"');
    });

    it("duplicate ids within a group produce no self-pair", () => {
      const f = fact({ id: "same", value: "postgres" });
      expect(proposeFactMerges([f, { ...f }])).toEqual([]);
    });

    it("output is fully deterministic across shuffles", () => {
      const inputs = [
        fact({ id: "d1", value: "postgres 16", corroborationCount: 3 }),
        fact({ id: "d2", value: "Postgres 16." }),
        fact({ id: "d3", value: "postgres 16 with pgvector" }),
        fact({ id: "d4", subject: "other", value: "postgres 16" }),
      ];
      const base = proposeFactMerges(inputs);
      for (const shuffled of [[...inputs].reverse(), [inputs[2]!, inputs[0]!, inputs[3]!, inputs[1]!]]) {
        expect(proposeFactMerges(shuffled)).toEqual(base);
      }
      expect(base.length).toBeGreaterThan(0);
    });
  });
});
