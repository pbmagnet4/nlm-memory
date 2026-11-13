/**
 * Embedder-cold transition tests — pure logic, no network/fs. Verifies
 * the 2-consecutive-check sustain requirement (a single blip does not
 * fire), the 6h re-alert while an episode stays cold, and reset on
 * recovery.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDER_ALERT_STATE,
  EMBEDDER_REALERT_MS,
  evaluateEmbedderTransition,
  type EmbedderAlertState,
} from "../../../../src/core/alerts/embedder-transition.js";

/** Cold episode established: fired at check 2 (00:05), down since 00:00. */
function firedState(): EmbedderAlertState {
  const first = evaluateEmbedderTransition(
    DEFAULT_EMBEDDER_ALERT_STATE,
    false,
    new Date("2026-07-22T00:00:00.000Z"),
  );
  return evaluateEmbedderTransition(
    first.next,
    false,
    new Date("2026-07-22T00:05:00.000Z"),
  ).next;
}

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
    expect(result.next).toEqual({
      notReadyStreak: 1,
      since: now.toISOString(),
      lastFiredAt: null,
    });
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
    // Payload of the first fire is unchanged — n8n consumes this shape.
    expect(second.event).toEqual({
      type: "nlm.health.embedder_cold",
      data: { current: "cold", latest: "ready", since: t1.toISOString() },
    });
    expect(second.next).toEqual({
      notReadyStreak: 2,
      since: t1.toISOString(),
      lastFiredAt: t2.toISOString(),
    });
  });

  it("does not re-fire soon after the first fire", () => {
    const start = firedState();
    const result = evaluateEmbedderTransition(start, false, new Date("2026-07-22T00:10:00.000Z"));
    expect(result.fire).toBe(false);
    expect(result.next).toEqual({
      notReadyStreak: 3,
      since: "2026-07-22T00:00:00.000Z",
      lastFiredAt: "2026-07-22T00:05:00.000Z",
    });
  });

  it("does not re-fire at 5h59m after the last fire", () => {
    const result = evaluateEmbedderTransition(
      firedState(),
      false,
      new Date("2026-07-22T06:04:00.000Z"),
    );
    expect(result.fire).toBe(false);
    expect(result.event).toBeNull();
  });

  it("re-fires at 6h with repeat markers and minutes down", () => {
    const now = new Date("2026-07-22T06:05:00.000Z");
    expect(EMBEDDER_REALERT_MS).toBe(6 * 60 * 60_000);

    const result = evaluateEmbedderTransition(firedState(), false, now);
    expect(result.fire).toBe(true);
    expect(result.event).toEqual({
      type: "nlm.health.embedder_cold",
      data: {
        current: "cold",
        latest: "ready",
        since: "2026-07-22T00:00:00.000Z",
        repeat: true,
        downMinutes: 365,
      },
    });
    expect(result.next).toEqual({
      notReadyStreak: 3,
      since: "2026-07-22T00:00:00.000Z",
      lastFiredAt: now.toISOString(),
    });
  });

  it("keeps re-firing every 6h while the episode continues", () => {
    const at6h = evaluateEmbedderTransition(
      firedState(),
      false,
      new Date("2026-07-22T06:05:00.000Z"),
    );
    const now = new Date("2026-07-22T18:05:00.000Z");
    const at18h = evaluateEmbedderTransition(at6h.next, false, now);

    expect(at18h.fire).toBe(true);
    expect(at18h.event?.data.repeat).toBe(true);
    // Whole minutes since `since` (00:00), not since the previous fire.
    expect(at18h.event?.data.downMinutes).toBe(1085);
    expect(at18h.next).toEqual({
      notReadyStreak: 4,
      since: "2026-07-22T00:00:00.000Z",
      lastFiredAt: now.toISOString(),
    });
  });

  it("re-alerts on the next check for a pre-T1867 state with no lastFiredAt", () => {
    // State written before lastFiredAt existed, mid-episode: without a
    // due-immediately rule the streak would sit past the sustain count
    // and never alert again.
    const legacy: EmbedderAlertState = {
      notReadyStreak: 4,
      since: "2026-07-22T00:00:00.000Z",
      lastFiredAt: null,
    };
    const result = evaluateEmbedderTransition(legacy, false, new Date("2026-07-22T00:10:00.000Z"));
    expect(result.fire).toBe(true);
    expect(result.event?.data.repeat).toBe(true);
    expect(result.event?.data.downMinutes).toBe(10);
    expect(result.next.lastFiredAt).toBe("2026-07-22T00:10:00.000Z");
  });

  it("resets on recovery after a fired cold episode", () => {
    const recovered = evaluateEmbedderTransition(
      firedState(),
      true,
      new Date("2026-07-22T00:10:00.000Z"),
    );
    expect(recovered.fire).toBe(false);
    expect(recovered.event).toBeNull();
    expect(recovered.next).toEqual(DEFAULT_EMBEDDER_ALERT_STATE);
  });

  it("resets a re-alerting episode on recovery", () => {
    const at6h = evaluateEmbedderTransition(
      firedState(),
      false,
      new Date("2026-07-22T06:05:00.000Z"),
    );
    const recovered = evaluateEmbedderTransition(
      at6h.next,
      true,
      new Date("2026-07-22T06:10:00.000Z"),
    );
    expect(recovered.fire).toBe(false);
    expect(recovered.next).toEqual(DEFAULT_EMBEDDER_ALERT_STATE);
  });
});
