import { describe, expect, it } from "vitest";
import { workSummaryHandler, type McpDeps } from "../../src/mcp/server.js";
import type { Session } from "../../src/shared/types.js";

const m = (min: number) => Date.parse("2026-06-23T10:00:00.000Z") + min * 60_000;

function sess(id: string, entities: string[]): Session {
  return {
    id, runtime: "claude-code", runtimeSessionId: id,
    startedAt: "2026-06-23T10:00:00.000Z", endedAt: "2026-06-23T11:00:00.000Z",
    durationMin: null, label: id, summary: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/fake/${id}.jsonl`,
    body: "", entities, decisions: [], open: [],
  };
}

describe("workSummaryHandler", () => {
  it("returns the composed digest text for a date", async () => {
    const deps = {
      workDigest: {
        store: { listByDateRange: async () => [sess("a", ["nlm"])] },
        readTimestamps: () => [m(0), m(10), m(30)],
        idleThresholdMin: 35,
        deepBlockMin: 25,
      },
    } as unknown as McpDeps;

    const res = await workSummaryHandler(deps, { date: "2026-06-23" });
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("DAILY WORK RECAP - 2026-06-23");
    expect(text).toContain("nlm");
  });

  it("returns a clear message when work-digest is not wired", async () => {
    const res = await workSummaryHandler({} as McpDeps, { date: "2026-06-23" });
    const text = (res.content?.[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("not available");
  });
});
