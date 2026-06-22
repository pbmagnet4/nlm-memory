import { describe, it, expect } from "vitest";
import { mergeHybridForTest as mergeHybrid } from "@core/recall/recall-service.js";
import type { Session } from "@shared/types.js";

const sess = (id: string): Session => ({
  id,
  runtime: "test",
  runtimeSessionId: id,
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  durationMin: null,
  label: id,
  summary: "",
  status: "active",
  transcriptKind: "text",
  transcriptPath: null,
  body: "",
  entities: [],
  decisions: [],
  open: [],
});

describe("session mergeHybrid keyword-primary banding", () => {
  it("ranks a strong keyword hit above a semantic-only hit", () => {
    const kw = [{ session: sess("k1"), score: 10, matchedIn: ["label"] as never }];
    const sem = [{ session: sess("s1"), similarity: 0.9 }];
    const rows = mergeHybrid(kw, sem);
    expect(rows[0]!.id).toBe("k1");
    expect(rows.find((r) => r.id === "s1")!.matchScore).toBeLessThan(rows[0]!.matchScore);
  });

  it("places keyword hits in the upper band [0.5, 1.0] and semantic-only below 0.5", () => {
    const kw = [{ session: sess("k1"), score: 10, matchedIn: ["label"] as never }];
    const sem = [{ session: sess("s1"), similarity: 0.9 }];
    const rows = mergeHybrid(kw, sem);
    const k1 = rows.find((r) => r.id === "k1")!;
    const s1 = rows.find((r) => r.id === "s1")!;
    expect(k1.matchScore).toBeGreaterThanOrEqual(0.5);
    expect(s1.matchScore).toBeLessThan(0.5);
  });

  it("degrades to pure keyword when semantic is unavailable", () => {
    const kw = [
      { session: sess("k1"), score: 10, matchedIn: ["label"] as never },
      { session: sess("k2"), score: 5, matchedIn: ["summary"] as never },
    ];
    const rows = mergeHybrid(kw, []);
    expect(rows.map((r) => r.id)).toEqual(["k1", "k2"]);
    expect(rows.every((r) => r.semanticScore === 0)).toBe(true);
  });
});
