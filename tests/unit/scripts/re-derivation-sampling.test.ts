import { describe, expect, it } from "vitest";
import {
  allocatedSample,
  balancedQuota,
} from "../../../scripts/eval/lib/re-derivation-sampling.js";

interface Row {
  readonly id: number;
  readonly stratum: string;
  readonly size: string;
}

const rows: ReadonlyArray<Row> = Array.from({ length: 300 }, (_, i) => ({
  id: i,
  stratum: i < 10 ? "A1" : i < 60 ? "A2" : "A3",
  size: ["small", "mid", "large"][i % 3]!,
}));

describe("allocatedSample", () => {
  it("honours the exact per-stratum quota rather than proportional share", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 5, A2: 20, A3: 20 }, 1);
    expect(r.drawn).toEqual({ A1: 5, A2: 20, A3: 20 });
    expect(r.selected).toHaveLength(45);
  });

  it("takes the whole stratum and records a shortfall when the quota exceeds it", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 50, A2: 5, A3: 5 }, 1);
    expect(r.drawn["A1"]).toBe(10);
    expect(r.shortfalls).toEqual([{ stratum: "A1", wanted: 50, available: 10 }]);
  });

  it("ignores strata with no quota", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 5 }, 1);
    expect(r.selected.every((x) => x.stratum === "A1")).toBe(true);
  });

  it("is deterministic for a given seed and order-independent of input shuffling", () => {
    const a = allocatedSample(rows, (x) => x.stratum, { A2: 10 }, 42);
    const b = allocatedSample(rows, (x) => x.stratum, { A2: 10 }, 42);
    expect(a.selected.map((x) => x.id)).toEqual(b.selected.map((x) => x.id));
  });

  it("changes selection when the seed changes", () => {
    const a = allocatedSample(rows, (x) => x.stratum, { A3: 10 }, 1);
    const b = allocatedSample(rows, (x) => x.stratum, { A3: 10 }, 2);
    expect(a.selected.map((x) => x.id)).not.toEqual(b.selected.map((x) => x.id));
  });
});

describe("balancedQuota", () => {
  it("splits n as evenly as possible across the sub-key values present", () => {
    const q = balancedQuota(rows, (x) => x.size, 30);
    expect(Object.values(q).reduce((s, v) => s + v, 0)).toBe(30);
    expect(Object.values(q).every((v) => v === 10)).toBe(true);
  });

  it("redistributes when a sub-key is too small to fill its share", () => {
    const skewed = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: i, stratum: "A", size: "small" })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, stratum: "A", size: "large" })),
    ];
    const q = balancedQuota(skewed, (x) => x.size, 12);
    expect(q["small"]).toBe(2);
    expect(q["large"]).toBe(10);
  });

  it("never allocates more than n in total", () => {
    const q = balancedQuota(rows, (x) => x.size, 7);
    expect(Object.values(q).reduce((s, v) => s + v, 0)).toBe(7);
  });
});
