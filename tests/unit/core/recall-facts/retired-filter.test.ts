import { describe, it, expect } from "vitest";
import { makeFilterPredicateForTest as makeFilterPredicate } from "@core/recall-facts/fact-recall-service.js";

describe("makeFilterPredicate", () => {
  it("excludes retired facts even when supersededBy is null", () => {
    const pred = makeFilterPredicate({});
    const retired = {
      id: "f1",
      supersededBy: null,
      retiredAt: "2026-01-01T00:00:00Z",
      confidence: 1,
      kind: "x",
      subject: "s",
      predicate: "p",
      value: "v",
    } as never;
    expect(pred(retired)).toBe(false);
  });

  it("admits an active, non-retired fact", () => {
    const pred = makeFilterPredicate({});
    const live = {
      id: "f2",
      supersededBy: null,
      retiredAt: null,
      confidence: 1,
      kind: "x",
      subject: "s",
      predicate: "p",
      value: "v",
    } as never;
    expect(pred(live)).toBe(true);
  });
});
