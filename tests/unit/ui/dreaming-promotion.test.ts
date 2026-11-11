import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { promotionDraft, promotionEdit, type PromotionSettings } from "../../../src/ui/lib/dream-promotion.js";
import { PromotionSection } from "../../../src/ui/pages/settings/Dreaming.js";

const current: PromotionSettings = {
  enabled: true,
  mode: "dry-run",
  sampleSize: 200,
  windowDays: 30,
  maxLines: 40,
  maxBytes: 4096,
  minCorroboration: 2,
};

function render(msg: string | null, draft = promotionDraft(current)): string {
  return renderToStaticMarkup(
    createElement(PromotionSection, { current, draft, busy: false, msg, onDraftChange: () => {}, onSave: () => {} }),
  );
}

describe("promotion pass card", () => {
  it("renders the current values", () => {
    const html = render(null);
    expect(html).toContain("Promotion pass");
    for (const v of ["200", "30", "40", "4096"]) expect(html).toContain(`value="${v}"`);
    expect(html).toContain('value="2"');
    expect(html).toContain("Min corroboration");
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
    const html = render(null, { ...promotionDraft(current), maxLines: "0" });
    expect(html).toContain("positive whole numbers");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save promotion settings/);
  });

  it("shows a server error inline", () => {
    const html = render("Error: dream settings: promotion.maxBytes must be a positive integer");
    expect(html).toContain("form-error");
    expect(html).toContain("promotion.maxBytes must be a positive integer");
  });
});
