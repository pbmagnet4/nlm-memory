/**
 * Embedder-cold transition tests — pure logic, no network/fs. Verifies
 * the 2-consecutive-check sustain requirement (a single blip does not
 * fire), the single edge-triggered fire per cold episode, and reset on
 * recovery.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDER_ALERT_STATE,
  evaluateEmbedderTransition,
} from "../../../../src/core/alerts/embedder-transition.js";

describe("evaluateEmbedderTransition", () => {
  it("does not fire while ready", () => {
    const result = evaluateEmbedderTransition(DEFAULT_EMBEDDER_ALERT_STATE, true, new Date());
    expect(result.fire).toBe(false);
    expect(result.next).toEqual(DEFAULT_EMBEDDER_ALERT_STATE);
  });

  it("does not fire on a single not-ready check (transient blip)", () => {
    const now = new Date("2026-07-22T00:00:00.000Z");
    const result = evaluateEmbedderTransition(DEFAULT_EMBEDDER_ALERT_STATE, false, now);
    expect(result.fire).toBe(false);
    expect(result.next).toEqual({ notReadyStreak: 1, since: now.toISOString() });
  });

  it("does not fire when a blip recovers before the 2nd check", () => {
    const first = evaluateEmbedderTransition(
      DEFAULT_EMBEDDER_ALERT_STATE,
      false,
      new Date("2026-07-22T00:00:00.000Z"),
    );
    const recovered = evaluateEmbedderTransition(first.next, true, new Date("2026-07-22T00:05:00.000Z"));
    expect(recovered.fire).toBe(false);
    expect(recovered.next).toEqual(DEFAULT_EMBEDDER_ALERT_STATE);
  });

  it("fires once sustained across 2 consecutive not-ready checks", () => {
    const t1 = new Date("2026-07-22T00:00:00.000Z");
    const t2 = new Date("2026-07-22T00:05:00.000Z");
    const first = evaluateEmbedderTransition(DEFAULT_EMBEDDER_ALERT_STATE, false, t1);
    const second = evaluateEmbedderTransition(first.next, false, t2);

    expect(second.fire).toBe(true);
    expect(second.event).toEqual({
      type: "nlm.health.embedder_cold",
      data: { current: "cold", latest: "ready", since: t1.toISOString() },
    });
    expect(second.next).toEqual({ notReadyStreak: 2, since: t1.toISOString() });
  });

  it("does not re-fire on further sustained not-ready checks", () => {
    const t1 = new Date("2026-07-22T00:00:00.000Z");
    const t2 = new Date("2026-07-22T00:05:00.000Z");
    const t3 = new Date("2026-07-22T00:10:00.000Z");
    const first = evaluateEmbedderTransition(DEFAULT_EMBEDDER_ALERT_STATE, false, t1);
    const second = evaluateEmbedderTransition(first.next, false, t2);
    const third = evaluateEmbedderTransition(second.next, false, t3);

    expect(third.fire).toBe(false);
    expect(third.next).toEqual({ notReadyStreak: 3, since: t1.toISOString() });
  });

  it("resets on recovery after a fired cold episode", () => {
    const t1 = new Date("2026-07-22T00:00:00.000Z");
    const t2 = new Date("2026-07-22T00:05:00.000Z");
    const first = evaluateEmbedderTransition(DEFAULT_EMBEDDER_ALERT_STATE, false, t1);
    const second = evaluateEmbedderTransition(first.next, false, t2);
    const recovered = evaluateEmbedderTransition(second.next, true, new Date("2026-07-22T00:10:00.000Z"));

    expect(recovered.fire).toBe(false);
    expect(recovered.next).toEqual(DEFAULT_EMBEDDER_ALERT_STATE);
  });
});
