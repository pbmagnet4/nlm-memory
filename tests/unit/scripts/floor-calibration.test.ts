import { describe, expect, it } from "vitest";
import { calibrateFloor, type FloorFire, type FloorGold } from "../../../scripts/eval/floor-calibration.js";

describe("calibrateFloor", () => {
  // One fire; median() of [10,8,4,2] is sorted[floor(4/2)] = sorted[2] = 8.
  // Gold is the score-10 hit; the three lower hits are noise.
  const fires: FloorFire[] = [
    { conversationId: "c", hits: [
      { id: "gold", score: 10 },
      { id: "n1", score: 8 },
      { id: "n2", score: 4 },
      { id: "n3", score: 2 },
    ] },
  ];
  const gold: FloorGold[] = [{ conversationId: "c", citedId: "gold" }];

  it("separates gold from noise on the absolute scale", () => {
    const cal = calibrateFloor(fires, gold);
    expect(cal.goldHits).toBe(1);
    expect(cal.noiseHits).toBe(3);
    const at5 = cal.absolute.find((p) => p.threshold === 5)!;
    expect(at5.goldKept).toBe(1); // gold (10) survives raw>=5
    expect(at5.noiseCut).toBeCloseTo(2 / 3, 5); // n2(4), n3(2) cut; n1(8) kept
  });

  it("recommends the portable floor with max noise-cut that keeps >= minGold", () => {
    // median = 8. gold rel = 10/8 = 1.25; noise rels = 1.0, 0.5, 0.25.
    // Only the 0.5 and 0.25 noise are cuttable below gold's 1.25; rel >= 0.7
    // already cuts both (noiseCut 2/3), so higher thresholds add nothing. The
    // recommender picks the lowest threshold reaching that max cut (safest for
    // gold). All thresholds keep 100% gold since gold rel 1.25 > 1.0.
    const cal = calibrateFloor(fires, gold, 0.95);
    expect(cal.recommended).not.toBeNull();
    expect(cal.recommended!.goldKept).toBe(1);
    expect(cal.recommended!.threshold).toBe(0.7);
    expect(cal.recommended!.noiseCut).toBeCloseTo(2 / 3, 5);
  });

  it("returns null recommendation when no portable floor preserves enough gold", () => {
    // Gold scores BELOW the fire median → every relative floor drops gold.
    const weakGold: FloorFire[] = [
      { conversationId: "c", hits: [
        { id: "gold", score: 2 },
        { id: "n1", score: 50 },
        { id: "n2", score: 40 },
      ] },
    ];
    const cal = calibrateFloor(weakGold, [{ conversationId: "c", citedId: "gold" }], 0.95);
    expect(cal.recommended).toBeNull();
  });

  it("ignores fires from conversations with no citations", () => {
    const cal = calibrateFloor(
      [...fires, { conversationId: "other", hits: [{ id: "x", score: 99 }] }],
      gold,
    );
    expect(cal.goldHits + cal.noiseHits).toBe(4); // only conversation "c" counts
  });
});
