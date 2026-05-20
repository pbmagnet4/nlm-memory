import { describe, expect, it } from "vitest";
import { keywordMatchFields } from "../../../src/core/recall/match-fields.js";
import { tokenSet } from "../../../src/core/recall/tokenize.js";
import { makeSession } from "../../fixtures/sessions.js";

describe("keywordMatchFields", () => {
  it("returns no fields for empty query tokens", () => {
    expect(keywordMatchFields(makeSession({ label: "anything" }), new Set())).toEqual([]);
  });

  it("reports the label field on a label match", () => {
    const session = makeSession({ label: "pgvector migration plan" });
    expect(keywordMatchFields(session, tokenSet("pgvector"))).toEqual(["label"]);
  });

  it("reports decisions and open from marker text", () => {
    const session = makeSession({
      decisions: ["picked Hono for HTTP"],
      open: ["whether to use Tauri later"],
    });
    expect(keywordMatchFields(session, tokenSet("Hono"))).toEqual(["decisions"]);
    expect(keywordMatchFields(session, tokenSet("Tauri"))).toEqual(["open"]);
  });

  it("reports every matching field in label, decisions, open, summary order", () => {
    const session = makeSession({
      label: "recall port",
      summary: "ported recall to TypeScript",
      decisions: ["use sqlite-vec for semantic recall"],
      open: ["recall stats endpoint"],
    });
    expect(keywordMatchFields(session, tokenSet("recall"))).toEqual([
      "label",
      "decisions",
      "open",
      "summary",
    ]);
  });
});
