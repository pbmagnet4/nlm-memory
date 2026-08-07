import { describe, it, expect } from "vitest";
import { buildWikiFailureEvent, buildWikiDriftEvent } from "@core/alerts/wiki-alert.js";
import type { ProjectionResult } from "@core/wiki/types.js";

function result(over: Partial<ProjectionResult> = {}): ProjectionResult {
  return { written: 0, unchanged: 0, removed: 0, qualifying: 10, onDisk: 10, coverageDrift: 0, ...over };
}

describe("buildWikiFailureEvent", () => {
  it("uses the projection_failed type", () => {
    expect(buildWikiFailureEvent(new Error("disk full")).type).toBe("nlm.wiki.projection_failed");
  });

  it("carries the error message", () => {
    expect(buildWikiFailureEvent(new Error("disk full")).data.message).toContain("disk full");
  });

  it("handles a thrown non-Error without crashing", () => {
    expect(buildWikiFailureEvent("boom").data.message).toContain("boom");
  });
});

describe("buildWikiDriftEvent", () => {
  it("returns null when the tree matches the corpus", () => {
    expect(buildWikiDriftEvent(result())).toBeNull();
  });

  it("fires when pages are missing from disk", () => {
    const event = buildWikiDriftEvent(result({ qualifying: 10, onDisk: 7, coverageDrift: 3 }));
    expect(event).not.toBeNull();
    expect(event!.type).toBe("nlm.wiki.coverage_drift");
    expect(event!.data.drift).toBe(3);
  });

  it("fires on negative drift, meaning stale files survived removal", () => {
    const event = buildWikiDriftEvent(result({ qualifying: 7, onDisk: 10, coverageDrift: -3 }));
    expect(event).not.toBeNull();
    expect(event!.data.drift).toBe(-3);
  });

  it("spells the direction out in the message so a relay cannot misread it", () => {
    const event = buildWikiDriftEvent(result({ qualifying: 10, onDisk: 7, coverageDrift: 3 }));
    expect(event!.data.message).toMatch(/3/);
  });
});
