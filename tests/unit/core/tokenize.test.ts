import { describe, expect, it } from "vitest";
import { tokenize, tokenSet } from "../../../src/core/recall/tokenize.js";

describe("tokenize", () => {
  it("returns empty array for nullish or empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it("lowercases all tokens", () => {
    expect(tokenize("Hello WORLD")).toEqual(["hello", "world"]);
  });

  it("matches the Python TOKEN_PATTERN [A-Za-z0-9][A-Za-z0-9_.-]*", () => {
    expect(tokenize("Hermes-Pi v1.2_beta")).toEqual(["hermes-pi", "v1.2_beta"]);
  });

  it("drops leading punctuation since tokens must start with [A-Za-z0-9]", () => {
    expect(tokenize("-leading +middle")).toEqual(["leading", "middle"]);
  });

  it("splits on whitespace and standalone punctuation", () => {
    expect(tokenize("foo, bar; baz")).toEqual(["foo", "bar", "baz"]);
  });
});

describe("tokenSet", () => {
  it("deduplicates", () => {
    expect(tokenSet("Foo foo FOO")).toEqual(new Set(["foo"]));
  });
});
