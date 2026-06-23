import { describe, expect, it } from "vitest";
import { mergeIntervals } from "../../../../src/core/work-digest/merge-active.js";

const m = (min: number) => min * 60_000;

describe("mergeIntervals", () => {
  it("returns empty + 0 minutes for no intervals", () => {
    expect(mergeIntervals([])).toEqual({ merged: [], totalMinutes: 0 });
  });

  it("merges two overlapping intervals into one (no double-count)", () => {
    const r = mergeIntervals([
      { start: 0, end: m(30) },
      { start: m(20), end: m(40) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(40) }]);
    expect(r.totalMinutes).toBe(40);
  });

  it("keeps disjoint intervals separate and sums their minutes", () => {
    const r = mergeIntervals([
      { start: 0, end: m(10) },
      { start: m(20), end: m(35) },
    ]);
    expect(r.merged).toEqual([
      { start: 0, end: m(10) },
      { start: m(20), end: m(35) },
    ]);
    expect(r.totalMinutes).toBe(25);
  });

  it("merges touching intervals (start == prior end)", () => {
    const r = mergeIntervals([
      { start: 0, end: m(10) },
      { start: m(10), end: m(15) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(15) }]);
    expect(r.totalMinutes).toBe(15);
  });

  it("absorbs a nested interval", () => {
    const r = mergeIntervals([
      { start: 0, end: m(60) },
      { start: m(10), end: m(20) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(60) }]);
    expect(r.totalMinutes).toBe(60);
  });

  it("sorts unsorted input before merging", () => {
    const r = mergeIntervals([
      { start: m(20), end: m(40) },
      { start: 0, end: m(25) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(40) }]);
  });
});
