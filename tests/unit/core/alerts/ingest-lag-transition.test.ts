import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGEST_LAG_ALERT_STATE,
  evaluateIngestLagTransition,
  type IngestLagAlertState,
} from "../../../../src/core/alerts/ingest-lag-transition.js";

const t = (iso: string) => new Date(iso);

describe("evaluateIngestLagTransition", () => {
  it("fires once on sustained entry and once on recovery", () => {
    const events: Array<{ current: string; latest: string; since: string }> = [];
    let state: IngestLagAlertState = DEFAULT_INGEST_LAG_ALERT_STATE;
    const steps: Array<[boolean, string]> = [
      [true, "2026-10-27T10:00:00Z"],
      [true, "2026-10-27T10:05:00Z"],
      [true, "2026-10-27T10:10:00Z"],
      [true, "2026-10-27T10:15:00Z"],
      [false, "2026-10-27T10:20:00Z"],
      [false, "2026-10-27T10:25:00Z"],
    ];
    for (const [lagging, at] of steps) {
      const r = evaluateIngestLagTransition(state, lagging, "412 pending, oldest 3d, 0 ok/1h", t(at));
      if (r.event) events.push(r.event.data);
      state = r.next;
    }
    expect(events).toEqual([
      { current: "412 pending, oldest 3d, 0 ok/1h", latest: "caught up", since: "2026-10-27T10:00:00.000Z" },
      { current: "caught up", latest: "caught up", since: "2026-10-27T10:00:00.000Z" },
    ]);
    expect(state).toEqual(DEFAULT_INGEST_LAG_ALERT_STATE);
  });

  it("stays silent for a single lagging blip", () => {
    const first = evaluateIngestLagTransition(DEFAULT_INGEST_LAG_ALERT_STATE, true, "s", t("2026-10-27T10:00:00Z"));
    const second = evaluateIngestLagTransition(first.next, false, "s", t("2026-10-27T10:05:00Z"));
    expect(first.event).toBeNull();
    expect(second.event).toBeNull();
    expect(second.next).toEqual(DEFAULT_INGEST_LAG_ALERT_STATE);
  });
});
