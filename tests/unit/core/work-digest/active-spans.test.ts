import { describe, expect, it } from "vitest";
import { activeSpans } from "../../../../src/core/work-digest/active-spans.js";

const m = (min: number) => min * 60_000;

describe("activeSpans", () => {
  it("returns no spans for an empty input", () => {
    expect(activeSpans([], 5)).toEqual([]);
  });

  it("returns a zero-length span for a single message", () => {
    expect(activeSpans([1000], 5)).toEqual([{ start: 1000, end: 1000 }]);
  });

  it("keeps messages within the idle threshold in one span", () => {
    const ts = [0, m(3), m(5)];
    expect(activeSpans(ts, 5)).toEqual([{ start: 0, end: m(5) }]);
  });

  it("splits on a gap larger than the threshold", () => {
    const ts = [0, m(2), m(20), m(22)];
    expect(activeSpans(ts, 5)).toEqual([
      { start: 0, end: m(2) },
      { start: m(20), end: m(22) },
    ]);
  });

  it("treats a gap exactly at the threshold as still active", () => {
    expect(activeSpans([0, m(5)], 5)).toEqual([{ start: 0, end: m(5) }]);
  });

  it("sorts unsorted input before computing", () => {
    expect(activeSpans([m(5), 0, m(2)], 5)).toEqual([{ start: 0, end: m(5) }]);
  });
});
