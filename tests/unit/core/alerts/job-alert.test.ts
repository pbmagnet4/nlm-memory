/**
 * buildJobAlertEvent — pure mapping from a JobSupervisorEvent to the
 * `nlm.job.stalled` AlertEvent. Covers all three event kinds and the
 * wording requirement: an "exhausted" event's restarts count is the number
 * of respawns that actually happened, so the message must read as "gave up
 * after N", never something a reader could mistake for restarts still to
 * come.
 */

import { describe, expect, it } from "vitest";
import { buildJobAlertEvent } from "../../../../src/core/alerts/job-alert.js";
import type { JobSupervisorEvent } from "../../../../src/core/jobs/job-supervisor.js";

describe("buildJobAlertEvent", () => {
  it("maps a stalled event to nlm.job.stalled with reason 'stalled'", () => {
    const event: JobSupervisorEvent = {
      kind: "stalled",
      job: "reprocess",
      processed: 12,
      total: 50,
      restarts: 0,
      restartsTotal: 0,
      lastAdvanceAt: "2026-08-01T00:00:00.000Z",
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.type).toBe("nlm.job.stalled");
    expect(alert.data.job).toBe("reprocess");
    expect(alert.data.reason).toBe("stalled");
    expect(alert.data.processed).toBe(12);
    expect(alert.data.total).toBe(50);
    expect(alert.data.restarts).toBe(0);
    expect(alert.data.lastAdvanceAt).toBe("2026-08-01T00:00:00.000Z");
    expect(alert.data.message).toContain("stalled");
    expect(alert.data.message).toContain("12/50");
  });

  it("maps an exhausted event to nlm.job.stalled with reason 'exhausted'", () => {
    const event: JobSupervisorEvent = {
      kind: "exhausted",
      job: "reprocess",
      processed: 30,
      total: 50,
      restarts: 3,
      restartsTotal: 3,
      lastAdvanceAt: "2026-08-01T00:10:00.000Z",
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.data.reason).toBe("exhausted");
    expect(alert.data.restarts).toBe(3);
  });

  it("words the exhausted message so the restarts count can't be misread as restarts still ahead", () => {
    const event: JobSupervisorEvent = {
      kind: "exhausted",
      job: "reprocess",
      processed: 30,
      total: 50,
      restarts: 3,
      restartsTotal: 3,
      lastAdvanceAt: "2026-08-01T00:10:00.000Z",
    };

    const alert = buildJobAlertEvent(event);

    // "gave up after 3" reads unambiguously as "3 restarts already spent,
    // now stopped" — not "3 more restarts about to happen".
    expect(alert.data.message).toMatch(/gave up after 3 fruitless restarts/);
    expect(alert.data.message).not.toMatch(/will restart|retrying|about to/i);
  });

  it("singularizes 'restart' when the count is 1", () => {
    const event: JobSupervisorEvent = {
      kind: "exhausted",
      job: "reprocess",
      processed: 5,
      total: 10,
      restarts: 1,
      restartsTotal: 1,
      lastAdvanceAt: null,
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.data.message).toMatch(/gave up after 1 fruitless restart(?!s)/);
  });

  it("handles a null lastAdvanceAt (stall with zero progress ever observed)", () => {
    const event: JobSupervisorEvent = {
      kind: "stalled",
      job: "reprocess",
      processed: 0,
      total: 0,
      restarts: 0,
      restartsTotal: 0,
      lastAdvanceAt: null,
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.data.lastAdvanceAt).toBeNull();
    expect(alert.data.message).toContain("start");
  });

  it("passes restartsTotal through unchanged, distinct from the resettable restarts counter", () => {
    const event: JobSupervisorEvent = {
      kind: "stalled",
      job: "reprocess",
      processed: 200,
      total: 664,
      restarts: 0, // reset by a recent advance
      restartsTotal: 12, // but this run has OOM-churned 12 times lifetime
      lastAdvanceAt: "2026-08-01T00:00:00.000Z",
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.data.restarts).toBe(0);
    expect(alert.data.restartsTotal).toBe(12);
  });

  it("maps a spawn_failed event to nlm.job.stalled with reason 'spawn_failed'", () => {
    const event: JobSupervisorEvent = {
      kind: "spawn_failed",
      job: "reprocess",
      processed: 0,
      total: 0,
      restarts: 0,
      restartsTotal: 0,
      lastAdvanceAt: null,
    };

    const alert = buildJobAlertEvent(event);

    expect(alert.type).toBe("nlm.job.stalled");
    expect(alert.data.reason).toBe("spawn_failed");
    expect(alert.data.message).toMatch(/failed to start/i);
  });
});
