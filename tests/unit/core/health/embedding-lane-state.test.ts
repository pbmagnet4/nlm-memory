import { beforeEach, describe, expect, it } from "vitest";
import {
  laneHealth,
  laneHealthSnapshot,
  resetLaneHealthForTests,
  setLaneHealth,
} from "../../../../src/core/health/embedding-lane-state.js";

describe("embedding lane state", () => {
  beforeEach(() => resetLaneHealthForTests());

  it("all lanes default to unknown", () => {
    expect(laneHealth("prose")).toBe("unknown");
    expect(laneHealth("code")).toBe("unknown");
  });

  it("setLaneHealth + laneHealth round-trip", () => {
    setLaneHealth("prose", "ok");
    expect(laneHealth("prose")).toBe("ok");
    setLaneHealth("prose", "stale");
    expect(laneHealth("prose")).toBe("stale");
  });

  it("lanes are independent", () => {
    setLaneHealth("prose", "ok");
    expect(laneHealth("code")).toBe("unknown");
  });

  it("laneHealthSnapshot reflects current state for all lanes", () => {
    setLaneHealth("prose", "ok");
    setLaneHealth("code", "stale");
    const snap = laneHealthSnapshot();
    expect(snap.prose).toBe("ok");
    expect(snap.code).toBe("stale");
  });

  it("laneHealthSnapshot is frozen", () => {
    const snap = laneHealthSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("resetLaneHealthForTests restores all lanes to unknown", () => {
    setLaneHealth("prose", "ok");
    setLaneHealth("code", "stale");
    resetLaneHealthForTests();
    expect(laneHealth("prose")).toBe("unknown");
    expect(laneHealth("code")).toBe("unknown");
  });
});
