import { beforeEach, describe, expect, it } from "vitest";
import {
  embedFailureSnapshot,
  recordEmbedFailure,
  resetEmbedFailureForTests,
} from "../../../../src/core/health/embed-failure-state.js";

describe("embed failure state", () => {
  beforeEach(() => resetEmbedFailureForTests());

  it("both kinds default to zero", () => {
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(0);
    expect(snap.fact).toBe(0);
  });

  it("recordEmbedFailure increments the named kind only", () => {
    recordEmbedFailure("chunk");
    recordEmbedFailure("chunk");
    recordEmbedFailure("fact");
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(2);
    expect(snap.fact).toBe(1);
  });

  it("embedFailureSnapshot is frozen", () => {
    expect(Object.isFrozen(embedFailureSnapshot())).toBe(true);
  });

  it("resetEmbedFailureForTests zeroes all counts", () => {
    recordEmbedFailure("chunk");
    recordEmbedFailure("fact");
    resetEmbedFailureForTests();
    const snap = embedFailureSnapshot();
    expect(snap.chunk).toBe(0);
    expect(snap.fact).toBe(0);
  });
});
