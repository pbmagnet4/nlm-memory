import { describe, expect, it } from "vitest";
import {
  CITATION_MAX_SHARE,
  lengthBucket,
  parseCitationLog,
  selectGoldSample,
  type GoldCandidate,
} from "../../../scripts/eval/lib/gold-selection.js";

describe("lengthBucket", () => {
  it("buckets short bodies", () => {
    expect(lengthBucket(0)).toBe("short");
    expect(lengthBucket(2_999)).toBe("short");
  });

  it("buckets medium bodies", () => {
    expect(lengthBucket(3_000)).toBe("medium");
    expect(lengthBucket(9_999)).toBe("medium");
  });

  it("buckets long bodies", () => {
    expect(lengthBucket(10_000)).toBe("long");
    expect(lengthBucket(200_000)).toBe("long");
  });
});

describe("parseCitationLog", () => {
  it("extracts distinct cited_id values", () => {
    const content = [
      '{"cited_id":"cc_a"}',
      '{"cited_id":"cc_b"}',
      '{"cited_id":"cc_a"}',
    ].join("\n");
    expect(parseCitationLog(content)).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("skips malformed lines without throwing", () => {
    const content = ['{"cited_id":"cc_a"}', "not json", '{"cited_id":"cc_b"}'].join("\n");
    expect(parseCitationLog(content)).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("skips rows with a missing or non-string cited_id", () => {
    const content = ['{"other":"x"}', '{"cited_id":42}', '{"cited_id":""}', '{"cited_id":"cc_c"}'].join("\n");
    expect(parseCitationLog(content)).toEqual(new Set(["cc_c"]));
  });

  it("skips blank lines", () => {
    const content = '{"cited_id":"cc_a"}\n\n\n{"cited_id":"cc_b"}\n';
    expect(parseCitationLog(content)).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("returns an empty set for empty content", () => {
    expect(parseCitationLog("")).toEqual(new Set());
  });
});

describe("selectGoldSample", () => {
  function makePool(specs: ReadonlyArray<{ runtime: string; bucket: "short" | "medium" | "long"; count: number }>): GoldCandidate[] {
    const lengths = { short: 100, medium: 5_000, long: 15_000 };
    const out: GoldCandidate[] = [];
    for (const { runtime, bucket, count } of specs) {
      for (let i = 0; i < count; i++) {
        out.push({ id: `${runtime}-${bucket}-${i}`, runtime, bodyLength: lengths[bucket] });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  it("returns nothing for an empty pool", () => {
    const result = selectGoldSample([], new Set(), 30, 1);
    expect(result.selectedIds).toHaveLength(0);
    expect(result.citationSelectedIds).toHaveLength(0);
    expect(result.fillSelectedIds).toHaveLength(0);
    expect(result.fillStrataCounts).toEqual({});
  });

  it("caps target at pool size when n exceeds it", () => {
    const pool = makePool([{ runtime: "claude-code", bucket: "medium", count: 5 }]);
    const result = selectGoldSample(pool, new Set(), 30, 1);
    expect(result.selectedIds).toHaveLength(5);
  });

  it("fills entirely via stratified sample when no ids are cited", () => {
    const pool = makePool([{ runtime: "claude-code", bucket: "medium", count: 40 }]);
    const result = selectGoldSample(pool, new Set(), 10, 1);
    expect(result.citationSelectedIds).toHaveLength(0);
    expect(result.fillSelectedIds).toHaveLength(10);
    expect(result.selectedIds).toHaveLength(10);
  });

  it("weights toward cited ids, capped at CITATION_MAX_SHARE of the target", () => {
    const pool = makePool([
      { runtime: "claude-code", bucket: "medium", count: 50 },
    ]);
    // Cite far more ids than the cap could ever take.
    const cited = new Set(pool.slice(0, 25).map((p) => p.id));
    const n = 10;
    const result = selectGoldSample(pool, cited, n, 1);
    const expectedCitationTake = Math.floor(n * CITATION_MAX_SHARE);
    expect(result.citationSelectedIds).toHaveLength(expectedCitationTake);
    expect(result.fillSelectedIds).toHaveLength(n - expectedCitationTake);
    for (const id of result.citationSelectedIds) expect(cited.has(id)).toBe(true);
  });

  it("takes every cited id when the cited pool is smaller than the cap", () => {
    const pool = makePool([{ runtime: "claude-code", bucket: "medium", count: 40 }]);
    const cited = new Set(pool.slice(0, 3).map((p) => p.id));
    const result = selectGoldSample(pool, cited, 10, 1);
    expect(result.citationSelectedIds).toHaveLength(3);
    expect(result.fillSelectedIds).toHaveLength(7);
  });

  it("never selects the same id via both citation weighting and fill", () => {
    const pool = makePool([{ runtime: "claude-code", bucket: "medium", count: 40 }]);
    const cited = new Set(pool.slice(0, 20).map((p) => p.id));
    const result = selectGoldSample(pool, cited, 10, 1);
    const unique = new Set(result.selectedIds);
    expect(unique.size).toBe(result.selectedIds.length);
  });

  it("is deterministic for a given seed", () => {
    const pool = makePool([
      { runtime: "claude-code", bucket: "short", count: 20 },
      { runtime: "claude-code", bucket: "long", count: 20 },
      { runtime: "hermes", bucket: "medium", count: 10 },
    ]);
    const cited = new Set(pool.slice(0, 8).map((p) => p.id));
    const first = selectGoldSample(pool, cited, 15, 99);
    const second = selectGoldSample(pool, cited, 15, 99);
    expect(first.selectedIds).toEqual(second.selectedIds);
    expect(first.fillStrataCounts).toEqual(second.fillStrataCounts);
  });

  it("diverges across seeds", () => {
    const pool = makePool([
      { runtime: "claude-code", bucket: "short", count: 20 },
      { runtime: "claude-code", bucket: "long", count: 20 },
    ]);
    const a = selectGoldSample(pool, new Set(), 10, 1);
    const b = selectGoldSample(pool, new Set(), 10, 2);
    expect(a.selectedIds).not.toEqual(b.selectedIds);
  });

  it("stratifies the fill proportionally across runtime x length-bucket strata", () => {
    const pool = makePool([
      { runtime: "claude-code", bucket: "short", count: 60 },
      { runtime: "claude-code", bucket: "long", count: 30 },
      { runtime: "hermes", bucket: "medium", count: 10 },
    ]);
    const result = selectGoldSample(pool, new Set(), 10, 5);
    // 60/100*10=6, 30/100*10=3, 10/100*10=1 - exact, no rounding needed.
    expect(result.fillStrataCounts["claude-code:short"]).toBe(6);
    expect(result.fillStrataCounts["claude-code:long"]).toBe(3);
    expect(result.fillStrataCounts["hermes:medium"]).toBe(1);
  });
});
