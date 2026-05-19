import { describe, expect, it } from "vitest";
import { scoreKeyword } from "../../../src/core/recall/score-keyword.js";
import { tokenSet } from "../../../src/core/recall/tokenize.js";
import { makeSession } from "../../fixtures/sessions.js";

describe("scoreKeyword", () => {
  it("returns zero score for empty query tokens", () => {
    const session = makeSession({ label: "anything" });
    const result = scoreKeyword(session, new Set());
    expect(result.score).toBe(0);
    expect(result.matchedIn).toEqual([]);
  });

  it("weights label matches at 3x per matching token", () => {
    const session = makeSession({ label: "pgvector migration plan" });
    const result = scoreKeyword(session, tokenSet("pgvector"));
    expect(result.score).toBe(3);
    expect(result.matchedIn).toEqual(["label"]);
  });

  it("weights summary matches at 1x per matching token", () => {
    const session = makeSession({ summary: "discussed deployment timing" });
    const result = scoreKeyword(session, tokenSet("deployment"));
    expect(result.score).toBe(1);
    expect(result.matchedIn).toEqual(["summary"]);
  });

  it("weights decisions and open at 2x per matching token", () => {
    const session = makeSession({
      decisions: ["picked Hono for HTTP"],
      open: ["whether to use Tauri later"],
    });
    expect(scoreKeyword(session, tokenSet("Hono"))).toEqual({
      score: 2,
      matchedIn: ["decisions"],
    });
    expect(scoreKeyword(session, tokenSet("Tauri"))).toEqual({
      score: 2,
      matchedIn: ["open"],
    });
  });

  it("combines weights across all fields when multiple match", () => {
    const session = makeSession({
      label: "recall port",
      summary: "ported recall to TypeScript",
      decisions: ["use sqlite-vec for semantic recall"],
      open: ["recall stats endpoint"],
    });
    const result = scoreKeyword(session, tokenSet("recall"));
    // label(3) + decisions(2) + open(2) + summary(1) = 8
    expect(result.score).toBe(8);
    expect(result.matchedIn).toEqual(["label", "decisions", "open", "summary"]);
  });

  it("counts multiple matching tokens within the same field", () => {
    const session = makeSession({ label: "hexagonal recall architecture" });
    const result = scoreKeyword(session, tokenSet("hexagonal architecture"));
    // 2 token matches in label * 3 weight = 6
    expect(result.score).toBe(6);
  });

  it("does not match tokens that fail the regex (e.g. bare punctuation)", () => {
    const session = makeSession({ label: "hello world" });
    const result = scoreKeyword(session, tokenSet("---"));
    expect(result.score).toBe(0);
  });
});
