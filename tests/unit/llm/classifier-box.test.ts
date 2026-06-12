import { describe, expect, it } from "vitest";
import { classifierNeedsThinkDisabled } from "../../../src/llm/classifier-box.js";

describe("classifierNeedsThinkDisabled", () => {
  it("returns true for qwen3.5:4b", () => {
    expect(classifierNeedsThinkDisabled("qwen3.5:4b")).toBe(true);
  });

  it("returns true for qwen3.5:9b", () => {
    expect(classifierNeedsThinkDisabled("qwen3.5:9b")).toBe(true);
  });

  it("returns false for qwen3:4b-instruct-2507-q4_K_M", () => {
    expect(classifierNeedsThinkDisabled("qwen3:4b-instruct-2507-q4_K_M")).toBe(false);
  });

  it("returns false for deepseek-v4-flash", () => {
    expect(classifierNeedsThinkDisabled("deepseek-v4-flash")).toBe(false);
  });
});
