import { describe, expect, it } from "vitest";
import { bodyVersion, persistedText } from "../../../../src/core/context/source-version.js";
import { locateSourceAnchor, validateSourceAnchor } from "../../../../src/core/facts/source-anchor.js";
import { extractFacts } from "../../../../src/core/facts/extract-facts.js";

describe("literal source anchors", () => {
  it("locates one literal occurrence with UTF-16 offsets and the transcript version", () => {
    const body = "😀 e\u0301 chose DuckDB.";
    const quote = "chose DuckDB";
    const anchor = locateSourceAnchor(body, quote);
    expect(bodyVersion("abc")).toBe("ba7816bf8f01cfea");
    expect(anchor).toEqual({ status: "verified", start: 6, end: 18, bodyVersion: bodyVersion(body) });
    if (anchor.status === "verified") expect(body.slice(anchor.start, anchor.end)).toBe(quote);
  });
  it.each([
    ["abc", undefined, "missing"], ["abc", "", "missing"], ["abc", "z", "invalid"],
    ["aa aa", "aa", "ambiguous"], ["aaaa", "aa", "ambiguous"],
  ] as const)("fails closed for %j / %j", (body, quote, status) => {
    expect(locateSourceAnchor(body, quote)).toEqual(status === "missing" ? { status } : { status, bodyVersion: bodyVersion(body) });
  });
  it("normalizes UTF-8 before locating quotes, including a cap cutting a surrogate pair", () => {
    const body = persistedText(("x".repeat(199_999) + "😀tail").slice(0, 200_000));
    expect(body.endsWith("�")).toBe(true);
    const facts = extractFacts({ label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 1,
      facts: [{ kind: "attribute", subject: "s", predicate: "p", value: "v", sourceQuote: "x\ud83d" }] },
    "s", "2026-01-01", { sourceBody: body });
    expect(facts[0]!.sourceQuote).toBe("x�");
    expect(facts[0]!.sourceAnchor).toEqual({ status: "verified", start: 199_998, end: 200_000, bodyVersion: bodyVersion(body) });
  });
  it("does not verify missing or changed versions and strips trusted offsets", () => {
    const anchor = locateSourceAnchor("abc", "b");
    expect(validateSourceAnchor(anchor, bodyVersion("abc"))).toEqual(anchor);
    expect(validateSourceAnchor(anchor, null)).toEqual({ status: "stale" });
    expect(validateSourceAnchor(anchor, bodyVersion("abcd"))).toEqual({ status: "stale" });
    expect(validateSourceAnchor(undefined, bodyVersion("abc"))).toEqual({ status: "missing" });
  });
});
