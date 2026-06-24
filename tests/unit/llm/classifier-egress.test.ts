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

  it("treats an openai provider pointed at a LAN/loopback endpoint as local", () => {
    expect(classifierEgressNotice("openai", "http://localhost:1234/v1")).toBeNull();
    expect(classifierEgressNotice("openai", "http://127.0.0.1:1234/v1")).toBeNull();
    expect(classifierEgressNotice("openai", "http://192.168.1.50:1234/v1")).toBeNull(); // private LAN
    expect(classifierEgressNotice("openai", "http://10.0.0.5:8000/v1")).toBeNull(); // private LAN
    expect(classifierEgressNotice("openai", "http://host.local:1234/v1")).toBeNull(); // mDNS
  });

  it("discloses egress for an openai provider pointed at a public endpoint", () => {
    const notice = classifierEgressNotice("openai", "https://api.openai.com/v1");
    expect(notice).not.toBeNull();
    expect(notice).toContain("api.openai.com");
    expect(notice).toContain("NLM_CLASSIFIER=ollama");
  });
});
