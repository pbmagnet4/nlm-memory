/**
 * Version-drift transition tests — pure logic, no network/fs. Verifies
 * the false→true single fire, the 48h-sustained + 24h-cadence re-fire,
 * suppression inside the grace window, and reset on recovery.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRIFT_ALERT_STATE,
  evaluateDriftTransition,
} from "../../../../src/core/alerts/drift-transition.js";

const STATUS_BEHIND = { current: "0.5.7", latest: "0.5.8", behind: true };
const STATUS_CURRENT = { current: "0.5.8", latest: "0.5.8", behind: false };

describe("evaluateDriftTransition", () => {
  it("does not fire while never behind", () => {
    const result = evaluateDriftTransition(DEFAULT_DRIFT_ALERT_STATE, STATUS_CURRENT, new Date());
    expect(result.fire).toBe(false);
    expect(result.event).toBeNull();
    expect(result.next).toEqual(DEFAULT_DRIFT_ALERT_STATE);
  });

  it("fires once on the false→true edge", () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const result = evaluateDriftTransition(DEFAULT_DRIFT_ALERT_STATE, STATUS_BEHIND, now);
    expect(result.fire).toBe(true);
    expect(result.event).toEqual({
      type: "nlm.drift.version_behind",
      data: { current: "0.5.7", latest: "0.5.8", since: now.toISOString() },
    });
    expect(result.next).toEqual({ behindSince: now.toISOString(), lastFiredAt: now.toISOString() });
  });

  it("does not re-fire on the next check within the 48h grace window", () => {
    const behindSince = "2026-07-20T00:00:00.000Z";
    const state = { behindSince, lastFiredAt: behindSince };
    const now = new Date("2026-07-21T00:00:00.000Z"); // 24h later
    const result = evaluateDriftTransition(state, STATUS_BEHIND, now);
    expect(result.fire).toBe(false);
    expect(result.next).toEqual(state);
  });

  it("re-fires once past 48h sustained, 24h since last fire", () => {
    const behindSince = "2026-07-20T00:00:00.000Z";
    const state = { behindSince, lastFiredAt: behindSince };
    const now = new Date("2026-07-22T01:00:00.000Z"); // 49h later
    const result = evaluateDriftTransition(state, STATUS_BEHIND, now);
    expect(result.fire).toBe(true);
    expect(result.event).toEqual({
      type: "nlm.drift.version_behind",
      data: { current: "0.5.7", latest: "0.5.8", since: behindSince },
    });
    expect(result.next).toEqual({ behindSince, lastFiredAt: now.toISOString() });
  });

  it("does not re-fire past 48h sustained if last fire was under 24h ago", () => {
    const behindSince = "2026-07-20T00:00:00.000Z";
    const lastFiredAt = "2026-07-22T00:30:00.000Z";
    const state = { behindSince, lastFiredAt };
    const now = new Date("2026-07-22T12:00:00.000Z"); // 60h since behind, 11.5h since last fire
    const result = evaluateDriftTransition(state, STATUS_BEHIND, now);
    expect(result.fire).toBe(false);
    expect(result.next).toEqual(state);
  });

  it("resets state on recovery (behind: false)", () => {
    const state = { behindSince: "2026-07-20T00:00:00.000Z", lastFiredAt: "2026-07-20T00:00:00.000Z" };
    const result = evaluateDriftTransition(state, STATUS_CURRENT, new Date("2026-07-23T00:00:00.000Z"));
    expect(result.fire).toBe(false);
    expect(result.event).toBeNull();
    expect(result.next).toEqual(DEFAULT_DRIFT_ALERT_STATE);
  });

  it("uses 'unknown' when latest is null", () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const result = evaluateDriftTransition(
      DEFAULT_DRIFT_ALERT_STATE,
      { current: "0.5.7", latest: null, behind: true },
      now,
    );
    expect(result.event?.data.latest).toBe("unknown");
  });
});
