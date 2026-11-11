import { describe, expect, it } from "vitest";
import { promotionDraft, promotionEdit, type PromotionSettings } from "../../../src/ui/lib/dream-promotion.js";

const current: PromotionSettings = {
  enabled: true,
  mode: "dry-run",
  sampleSize: 200,
  windowDays: 30,
  maxLines: 40,
  maxBytes: 4096,
  minCorroboration: 2,
};

describe("promotion pass card", () => {
  it("drafts the current values as strings", () => {
    expect(promotionDraft(current)).toEqual({
      enabled: "true", mode: "dry-run", sampleSize: "200", windowDays: "30",
      maxLines: "40", maxBytes: "4096", minCorroboration: "2",
    });
  });

  it("patches only changed fields", () => {
    const d = { ...promotionDraft(current), minCorroboration: "3", mode: "apply" };
    const e = promotionEdit(current, d);
    expect(e.patch).toEqual({ mode: "apply", minCorroboration: 3 });
    expect(e.invalid).toEqual([]);
    expect(promotionEdit(current, promotionDraft(current)).patch).toEqual({});
  });

  it("blocks non-positive or non-integer numbers client-side", () => {
    for (const bad of ["0", "-1", "1.5", "", "abc"]) {
      const e = promotionEdit(current, { ...promotionDraft(current), minCorroboration: bad });
      expect(e.invalid).toEqual(["minCorroboration"]);
      expect(e.patch).toEqual({});
    }
  });
});
