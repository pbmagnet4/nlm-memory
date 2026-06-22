import { describe, expect, it } from "vitest";
import { classifierEgressNotice } from "../../../src/llm/classifier-egress.js";

describe("classifierEgressNotice", () => {
  it("returns null for the local provider (nothing leaves the machine)", () => {
    expect(classifierEgressNotice("ollama")).toBeNull();
  });

  it("discloses the endpoint for a cloud provider", () => {
    const notice = classifierEgressNotice("deepseek");
    expect(notice).not.toBeNull();
    expect(notice).toContain("api.deepseek.com");
    expect(notice).toContain("NLM_CLASSIFIER=ollama");
  });

  it("is case-insensitive", () => {
    expect(classifierEgressNotice("DeepSeek")).toContain("api.deepseek.com");
  });

  it("treats unknown providers as local (no false disclosure)", () => {
    expect(classifierEgressNotice("some-local-thing")).toBeNull();
  });
});
