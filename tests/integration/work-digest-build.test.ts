import { describe, expect, it } from "vitest";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import type { Session } from "../../src/shared/types.js";

function session(over: Partial<Session> & { id: string }): Session {
  const base: Session = {
    id: over.id, runtime: "claude-code", runtimeSessionId: over.id,
    startedAt: "2026-06-23T10:00:00.000Z", endedAt: "2026-06-23T11:00:00.000Z",
    durationMin: null, label: over.label ?? over.id, summary: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/fake/${over.id}.jsonl`,
    body: "", entities: over.entities ?? [], decisions: over.decisions ?? [],
    open: over.open ?? [],
  };
  return { ...base, ...over };
}

const m = (min: number) => Date.parse("2026-06-23T10:00:00.000Z") + min * 60_000;

describe("buildWorkDigest", () => {
  it("computes attention, focus, progress, and coverage from sessions + transcripts", async () => {
    const sessions: Session[] = [
      session({ id: "a", entities: ["nlm"], decisions: ["chose option B"], open: ["validate B"] }),
      session({ id: "b", entities: ["acme"], decisions: [] }),
      session({ id: "c", entities: ["nlm"], transcriptPath: null }), // skipped
    ];
    const timestamps: Record<string, number[]> = {
      "/fake/a.jsonl": [m(0), m(10), m(30)], // 30 min, topic nlm
      "/fake/b.jsonl": [m(40), m(50)],       // 10 min, topic acme
    };
    const digest = await buildWorkDigest( 
      {
        store: { listByDateRange: async () => sessions },
        readTimestamps: (path) => timestamps[path] ?? [],
        idleThresholdMin: 35,
        deepBlockMin: 25,
      }, "team_local",
      "2026-06-23");

    expect(digest.date).toBe("2026-06-23");
    expect(digest.activeMinutes).toBe(40);
    expect(digest.byTopic).toEqual([
      { topic: "nlm", activeMinutes: 30, share: 0.75 },
      { topic: "acme", activeMinutes: 10, share: 0.25 },
    ]);
    expect(digest.coverage).toEqual({ sessions: 3, activeTimeMeasured: 2, activeTimeSkipped: 1 });
    expect(digest.progress.decisions).toContain("chose option B");
    expect(digest.progress.openLoops).toContain("validate B");
    expect(digest.scopeNote).toContain("Agent-assisted active time");
  });

  it("returns a valid empty digest for a day with no activity", async () => {
    const digest = await buildWorkDigest( 
      { store: { listByDateRange: async () => [] }, readTimestamps: () => [] }, "team_local",
      "2026-06-23");
    expect(digest.activeMinutes).toBe(0);
    expect(digest.byTopic).toEqual([]);
    expect(digest.coverage.sessions).toBe(0);
  });
});
