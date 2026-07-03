import { beforeEach, describe, expect, it } from "vitest";
import { setCorpusSnapshot, corpusSnapshot, resetForTests } from "../../../../src/core/health/corpus-state.js";

const baseStats = {
  dbBytes: 1000,
  sessions: 5,
  bodyBytes: 400,
  cappedBodies: 0,
  entities: 10,
  hapaxEntities: 6,
  factsActive: 3,
  factsSuperseded: 1,
  factsRetired: 0,
  markers: 8,
  exemplars: 2,
};

describe("corpus state singleton", () => {
  beforeEach(() => resetForTests());

  it("starts null before any snapshot is set", () => {
    expect(corpusSnapshot()).toBeNull();
  });

  it("returns the snapshot after set", () => {
    const snap = { ...baseStats, state: "ok" as const, lastComputedAt: "2026-07-03T00:00:00.000Z" };
    setCorpusSnapshot(snap);
    expect(corpusSnapshot()).toEqual(snap);
  });

  it("replaces an existing snapshot on second set", () => {
    const first = { ...baseStats, state: "ok" as const, lastComputedAt: "2026-07-03T00:00:00.000Z" };
    const second = { ...baseStats, dbBytes: 2_000_000_000, state: "alert" as const, lastComputedAt: "2026-07-03T01:00:00.000Z" };
    setCorpusSnapshot(first);
    setCorpusSnapshot(second);
    expect(corpusSnapshot()?.state).toBe("alert");
    expect(corpusSnapshot()?.dbBytes).toBe(2_000_000_000);
  });

  it("resetForTests returns snapshot to null", () => {
    setCorpusSnapshot({ ...baseStats, state: "warn" as const, lastComputedAt: "2026-07-03T00:00:00.000Z" });
    resetForTests();
    expect(corpusSnapshot()).toBeNull();
  });
});
