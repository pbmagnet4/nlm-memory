import { describe, expect, it } from "vitest";
import { detectCommitShas } from "../../../../src/core/exemplars/detect-commits.js";

describe("detectCommitShas", () => {
  it("finds the sha in standard git commit output", () => {
    expect(detectCommitShas("[main 1a2b3c4] add adder\n 1 file changed")).toEqual(["1a2b3c4"]);
  });
  it("handles root-commit and detached HEAD forms", () => {
    expect(detectCommitShas("[main (root-commit) abcdef1] init")).toEqual(["abcdef1"]);
    expect(detectCommitShas("[detached HEAD 0011223] wip")).toEqual(["0011223"]);
  });
  it("dedupes repeated shas, preserves order", () => {
    expect(detectCommitShas("[main 1a2b3c4] a\n...\n[main 1a2b3c4] a\n[main 9f8e7d6] b"))
      .toEqual(["1a2b3c4", "9f8e7d6"]);
  });
  it("returns empty for text with no commit output", () => {
    expect(detectCommitShas("just talking about code, no commits here")).toEqual([]);
  });
  it("does not match bracketed dates or short hex", () => {
    expect(detectCommitShas("see [2026-06-19] and [abc]")).toEqual([]);
  });
});
