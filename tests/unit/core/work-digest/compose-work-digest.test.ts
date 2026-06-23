import { describe, expect, it } from "vitest";
import { composeWorkDigest } from "../../../../src/core/work-digest/compose-work-digest.js";
import type { WorkDigest } from "../../../../src/core/work-digest/types.js";

const base: WorkDigest = {
  date: "2026-06-23",
  idleThresholdMin: 5,
  scopeNote: "Agent-assisted active time. Excludes meetings and work without an agent.",
  coverage: { sessions: 12, activeTimeMeasured: 10, activeTimeSkipped: 2 },
  activeMinutes: 372,
  byTopic: [
    { topic: "nlm", activeMinutes: 180, share: 0.48 },
    { topic: "client", activeMinutes: 84, share: 0.22 },
  ],
  focus: { contextSwitches: 14, longestBlockMin: 95, deepWorkRatio: 0.58, projectsTouched: 5 },
  progress: { decisions: ["chose option B"], openLoops: ["validate B over a real week"] },
};

describe("composeWorkDigest", () => {
  it("renders the scope note, attention, focus, and progress", () => {
    const out = composeWorkDigest(base);
    expect(out).toContain("2026-06-23");
    expect(out).toContain("Agent-assisted active time");
    expect(out).toContain("nlm");
    expect(out).toContain("48%");
    expect(out).toContain("context switches: 14");
    expect(out).toContain("chose option B");
    expect(out).toContain("validate B over a real week");
    // small list: header on its own line, bullet on next line
    expect(out).toContain("  decided (1):");
    expect(out).toContain("   - chose option B");
    expect(out).toContain("  open loops (1):");
    expect(out).toContain("   - validate B over a real week");
  });

  it("shows a coverage line when some sessions were skipped", () => {
    expect(composeWorkDigest(base)).toContain("2 session");
  });

  it("never emits an em dash in operator-facing copy", () => {
    expect(composeWorkDigest(base)).not.toContain("—");
  });

  it("renders an explicit empty-day line when there is no active time", () => {
    const empty: WorkDigest = {
      ...base,
      activeMinutes: 0,
      byTopic: [],
      coverage: { sessions: 0, activeTimeMeasured: 0, activeTimeSkipped: 0 },
      focus: { contextSwitches: 0, longestBlockMin: 0, deepWorkRatio: 0, projectsTouched: 0 },
      progress: { decisions: [], openLoops: [] },
    };
    expect(composeWorkDigest(empty)).toContain("no agent-assisted work recorded");
  });

  it("caps long decided and open loops lists at 8, showing the most recent", () => {
    const decisions = Array.from({ length: 20 }, (_, i) => `decision-${i}`);
    const openLoops = Array.from({ length: 15 }, (_, i) => `loop-${i}`);
    const large: WorkDigest = {
      ...base,
      progress: { decisions, openLoops },
    };
    const out = composeWorkDigest(large);

    // decided: large header
    expect(out).toContain("  decided: 20 (showing last 8)");
    // exactly 8 decision bullet lines
    const decisionBullets = out.split("\n").filter((l) => l.startsWith("   - decision-"));
    expect(decisionBullets).toHaveLength(8);
    // last item (most recent) is present
    expect(out).toContain("   - decision-19");
    // oldest item is pruned
    expect(out).not.toContain("   - decision-0");
    // overflow trailer
    expect(out).toContain("   ... (+12 more)");

    // open loops: large header
    expect(out).toContain("  open loops: 15 (showing last 8)");
    // overflow trailer
    expect(out).toContain("   ... (+7 more)");
  });
});
