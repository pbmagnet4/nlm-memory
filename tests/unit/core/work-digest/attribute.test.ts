import { describe, expect, it } from "vitest";
import { attribute } from "../../../../src/core/work-digest/attribute.js";
import type { Interval, SessionActivity } from "../../../../src/core/work-digest/types.js";

const m = (min: number) => min * 60_000;

describe("attribute", () => {
  it("returns zeros for an empty timeline", () => {
    const r = attribute([], [], { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([]);
    expect(r.focus).toEqual({ contextSwitches: 0, longestBlockMin: 0, deepWorkRatio: 0, projectsTouched: 0 });
  });

  it("attributes a single block to its only session and reports one deep block", () => {
    const merged: Interval[] = [{ start: 0, end: m(40) }];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(10), m(40)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([{ topic: "nlm", activeMinutes: 40, share: 1 }]);
    expect(r.focus).toEqual({ contextSwitches: 0, longestBlockMin: 40, deepWorkRatio: 1, projectsTouched: 1 });
  });

  it("counts a context switch between two adjacent single-topic blocks", () => {
    const merged: Interval[] = [
      { start: 0, end: m(30) },
      { start: m(40), end: m(50) },
    ];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(30)] },
      { sessionId: "b", topic: "client", timestampsMs: [m(40), m(50)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([
      { topic: "nlm", activeMinutes: 30, share: 0.75 },
      { topic: "client", activeMinutes: 10, share: 0.25 },
    ]);
    expect(r.focus.contextSwitches).toBe(1);
    expect(r.focus.longestBlockMin).toBe(30);
    expect(r.focus.projectsTouched).toBe(2);
    // only the 30-min block clears deepBlockMin=25
    expect(r.focus.deepWorkRatio).toBe(0.75);
  });

  it("picks the dominant session by message count when sessions overlap a block", () => {
    const merged: Interval[] = [{ start: 0, end: m(20) }];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(5), m(10), m(15)] },
      { sessionId: "b", topic: "client", timestampsMs: [m(12)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([{ topic: "nlm", activeMinutes: 20, share: 1 }]);
  });
});
